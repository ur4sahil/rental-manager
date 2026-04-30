import React, { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "../supabase";
import { Btn, Card, Input, Textarea, Select, FilterPill, PageHeader } from "../ui";
import { pmError } from "../utils/errors";
import { Spinner, Modal } from "./shared";
import { eventLabels } from "./Notifications";

// Per-LLC notification rule editor. Lives behind Admin → Notifications.
// Lets admins decide for every event type:
//   • Channels (in_app / email / push)
//   • Recipients — any combination of roles, named users, contextual
//     stand-ins (tenant of record, owner of record, property manager),
//     and literal cc/bcc addresses
//   • Quiet hours window (per-rule, with timezone)
//   • Subject + body templates with {{var}} substitution
//   • Severity flag
//
// notification_settings is per (company_id, event_type). On first
// mount we auto-seed missing rows for every event in eventLabels with
// safe defaults, so the editor always has a row to act on.

const RECIPIENT_PRESETS = [
  { kind: "role", value: "admin",          label: "Every admin",           explain: "All active members with admin role" },
  { kind: "role", value: "manager",        label: "Every manager",         explain: "All active managers" },
  { kind: "role", value: "office_assistant", label: "Every office assistant", explain: "All active office assistants" },
  { kind: "role", value: "accountant",     label: "Every accountant",      explain: "All active accountants" },
  { kind: "role", value: "maintenance",    label: "Every maintenance staff", explain: "All active maintenance staff" },
  { kind: "tenant",  value: null,          label: "Tenant of record",      explain: "The tenant the event is about" },
  { kind: "owner",   value: null,          label: "Owner of record",       explain: "The property owner" },
  { kind: "property_manager", value: null, label: "Property's manager",    explain: "The manager assigned to the property" },
];

const TZ_OPTIONS = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "UTC",
];

const SEVERITY_OPTIONS = [
  { value: "low",    label: "Low",    desc: "Informational; can be batched/digested" },
  { value: "normal", label: "Normal", desc: "Standard delivery" },
  { value: "high",   label: "High",   desc: "Urgent; bypasses some rate limits" },
];

// Defaults applied when seeding a fresh notification_settings row.
function defaultsForType(type) {
  return {
    enabled: true,
    channels: { in_app: true, email: true, push: true },
    recipients: "all",
    custom_recipients: [],
    cc: [],
    bcc: [],
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_tz: "America/New_York",
    severity: "normal",
    subject_template: null,
    template: null,
    days_before: type === "rent_due" ? 3 : type === "lease_expiry" ? 60 : null,
  };
}

// Group event types by category for the master list.
function groupedEvents() {
  const groups = new Map();
  for (const [type, info] of Object.entries(eventLabels)) {
    const cat = info.category || "Other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ type, ...info });
  }
  return Array.from(groups.entries());
}

// Tiny {{var}} renderer — mirrors the worker's logic so the live
// preview matches what Resend will actually send.
function renderTemplate(tmpl, data) {
  if (!tmpl) return "";
  return String(tmpl).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = data?.[key];
    return v === undefined || v === null ? "{{" + key + "}}" : String(v);
  });
}

// Sample data used in the live preview. Best-effort representation of
// what each event type's payload typically carries.
function sampleDataFor(type) {
  const base = { company_name: "Smith Properties LLC", app_url: "https://your-housify-domain.app" };
  const map = {
    rent_due: { ...base, tenant: "Jane Doe", property: "123 Main St", amount: "$1,500", date: "2026-05-01", month: "2026-05" },
    payment_received: { ...base, tenant: "Jane Doe", amount: "$1,500", date: "2026-04-29", property: "123 Main St" },
    payment_received_admin: { ...base, tenant: "Jane Doe", amount: "$1,500", date: "2026-04-29", property: "123 Main St" },
    message_received: { ...base, sender: "Jane Doe", tenant: "Jane Doe", property: "123 Main St", preview: "Hi, when can someone come look at the leak?" },
    work_order_created: { ...base, tenant: "Jane Doe", property: "123 Main St", issue: "Leaking faucet", priority: "normal" },
    lease_expiry: { ...base, tenant: "Jane Doe", property: "123 Main St", date: "2026-12-31", daysLeft: 60 },
    move_in: { ...base, tenant: "Jane Doe", property: "123 Main St", moveInDate: "2026-05-01" },
  };
  return map[type] || base;
}

export default function NotificationRulesPanel({ companyId, userProfile, showToast, showConfirm }) {
  const [settings, setSettings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState(null);
  const [search, setSearch] = useState("");

  const fetchSettings = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const { data } = await supabase.from("notification_settings")
        .select("*").eq("company_id", companyId);
      const byType = new Map((data || []).map(r => [r.event_type, r]));

      // Seed any missing rows so the editor always has something to
      // act on. One upsert per known event_type.
      const missing = [];
      for (const type of Object.keys(eventLabels)) {
        if (!byType.has(type)) {
          missing.push({ company_id: companyId, event_type: type, ...defaultsForType(type) });
        }
      }
      if (missing.length > 0) {
        const { data: inserted } = await supabase.from("notification_settings")
          .upsert(missing, { onConflict: "company_id,event_type" }).select();
        for (const r of (inserted || [])) byType.set(r.event_type, r);
      }
      setSettings(Array.from(byType.values()));
    } catch (e) {
      pmError("PM-8006", { raw: e, context: "fetch notification_settings", silent: true });
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // Quick toggle from the master list — flips `enabled` on a single row
  // without opening the editor. Optimistically updates local state, then
  // persists. Reverts and toasts on failure.
  const quickToggleEnabled = useCallback(async (type, nextEnabled) => {
    const row = settings.find(s => s.event_type === type);
    if (!row?.id) return;
    setSettings(prev => prev.map(s => s.event_type === type ? { ...s, enabled: nextEnabled } : s));
    const { error } = await supabase.from("notification_settings")
      .update({ enabled: nextEnabled }).eq("id", row.id);
    if (error) {
      setSettings(prev => prev.map(s => s.event_type === type ? { ...s, enabled: !nextEnabled } : s));
      showToast("Couldn't update: " + (error.message || "unknown"), "error");
    }
  }, [settings, showToast]);

  const settingByType = useMemo(() => {
    const m = new Map();
    for (const s of settings) m.set(s.event_type, s);
    return m;
  }, [settings]);

  const groups = useMemo(() => {
    const all = groupedEvents();
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.map(([cat, items]) => [cat, items.filter(i =>
      i.label.toLowerCase().includes(q) || i.type.includes(q) || (i.desc || "").toLowerCase().includes(q)
    )]).filter(([_c, items]) => items.length > 0);
  }, [search]);

  const activeSetting = activeType ? settingByType.get(activeType) : null;
  const activeMeta = activeType ? eventLabels[activeType] : null;

  if (loading) return <div className="py-12 flex justify-center"><Spinner /></div>;

  return (
    <div>
      <PageHeader
        title="Notification rules"
        subtitle="Per-event control over who's notified, when, on what channels, and exactly what they see. Applies to this company only."
      />
      <div className="mb-4">
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search events..." size="sm" />
      </div>
      <div className="space-y-6">
        {groups.map(([category, items]) => (
          <div key={category}>
            <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2 px-1">{category}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {items.map(({ type, label, icon, desc }) => {
                const s = settingByType.get(type);
                const enabled = s ? s.enabled !== false : true;
                const recipientsCount = (s?.custom_recipients || []).length;
                const hasQuiet = !!(s?.quiet_hours_start && s?.quiet_hours_end);
                const hasCustomSubject = !!s?.subject_template;
                const hasCustomBody = !!s?.template;
                return (
                  <div key={type}
                    role="button" tabIndex={0}
                    onClick={() => setActiveType(type)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveType(type); } }}
                    className={"cursor-pointer rounded-2xl border bg-white px-4 py-3 transition-colors hover:border-brand-300 " + (enabled ? "border-brand-100" : "border-neutral-200 opacity-60")}>
                    <div className="flex items-start gap-3">
                      <div className="text-2xl shrink-0">{icon}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold text-neutral-800 truncate">{label}</div>
                        </div>
                        <div className="text-xs text-neutral-500 mt-0.5 truncate">{desc}</div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {recipientsCount > 0 && <FilterPill tone="brand">{recipientsCount} recipient{recipientsCount === 1 ? "" : "s"}</FilterPill>}
                          {hasQuiet && <FilterPill tone="warn">Quiet hours</FilterPill>}
                          {hasCustomSubject && <FilterPill tone="info">Custom subject</FilterPill>}
                          {hasCustomBody && <FilterPill tone="info">Custom body</FilterPill>}
                        </div>
                      </div>
                      <div className="shrink-0" onClick={e => e.stopPropagation()}>
                        <ToggleSwitch on={enabled} onChange={v => quickToggleEnabled(type, v)} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {activeType && activeSetting && (
        <RuleEditor
          companyId={companyId}
          userProfile={userProfile}
          showToast={showToast}
          showConfirm={showConfirm}
          eventType={activeType}
          eventMeta={activeMeta}
          setting={activeSetting}
          onClose={() => setActiveType(null)}
          onSaved={(updated) => {
            setSettings(prev => prev.map(s => s.event_type === updated.event_type ? updated : s));
            setActiveType(null);
          }}
        />
      )}
    </div>
  );
}

function RuleEditor({ companyId, userProfile, showToast, showConfirm, eventType, eventMeta, setting, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => normalizeDraft(setting));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const channels = draft.channels || { in_app: true, email: true, push: true };

  function patch(updates) { setDraft(d => ({ ...d, ...updates })); }
  function patchChannels(updates) { setDraft(d => ({ ...d, channels: { ...(d.channels || {}), ...updates } })); }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        enabled: draft.enabled !== false,
        channels: draft.channels,
        recipients: draft.recipients || "all",
        custom_recipients: draft.custom_recipients || [],
        cc: draft.cc || [],
        bcc: draft.bcc || [],
        quiet_hours_start: draft.quiet_hours_start || null,
        quiet_hours_end: draft.quiet_hours_end || null,
        quiet_hours_tz: draft.quiet_hours_tz || "America/New_York",
        severity: draft.severity || "normal",
        subject_template: draft.subject_template || null,
        template: draft.template || null,
        days_before: draft.days_before == null ? null : Number(draft.days_before),
      };
      const { data, error } = await supabase.from("notification_settings")
        .update(payload).eq("id", setting.id).select().maybeSingle();
      if (error) throw error;
      showToast("Rule saved.", "success");
      onSaved(data || { ...setting, ...payload });
    } catch (e) {
      pmError("PM-8006", { raw: e, context: "save notification rule" });
      showToast("Save failed: " + (e.message || "unknown"), "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    if (testing || !userProfile?.email) return;
    setTesting(true);
    try {
      // Insert a one-shot queue row addressed to the admin so the
      // worker exercises the actual send path, including this rule's
      // subject/body/cc/bcc.
      const sample = sampleDataFor(eventType);
      const { error } = await supabase.from("notification_queue").insert({
        company_id: companyId,
        type: eventType,
        recipient_email: userProfile.email.toLowerCase(),
        data: JSON.stringify({ ...sample, _test: true }),
        status: "pending",
        cc: draft.cc || [],
        bcc: draft.bcc || [],
      });
      if (error) throw error;
      // Trigger worker
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (jwt) {
        await fetch("/api/notifications?action=worker", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
          body: "{}",
        }).catch(() => {});
      }
      showToast("Test queued — check " + userProfile.email + " in a few seconds.", "success");
    } catch (e) {
      showToast("Test failed: " + e.message, "error");
    } finally {
      setTesting(false);
    }
  }

  const sample = useMemo(() => sampleDataFor(eventType), [eventType]);
  const previewSubject = useMemo(() => renderTemplate(draft.subject_template || "", sample), [draft.subject_template, sample]);
  const previewBody = useMemo(() => renderTemplate(draft.template || "", sample), [draft.template, sample]);
  const isTimeBased = ["rent_due", "rent_overdue", "lease_expiring", "lease_expiry", "insurance_expiring", "inspection_due"].includes(eventType);

  return (
    <Modal onClose={onClose} title={eventMeta?.icon + " " + eventMeta?.label}>
      <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
        <div className="text-xs text-neutral-500">{eventMeta?.desc}</div>

        {/* Master toggle */}
        <div className="flex items-center justify-between bg-brand-50/40 border border-brand-100 rounded-2xl p-3">
          <div>
            <div className="text-sm font-semibold text-neutral-800">Rule active</div>
            <div className="text-xs text-neutral-500">When off, no email/push/in-app fires for this event.</div>
          </div>
          <ToggleSwitch on={draft.enabled !== false} onChange={v => patch({ enabled: v })} />
        </div>

        {/* Channels */}
        <Section title="Channels" hint="Which delivery channels are active for this rule.">
          <div className="flex gap-2 flex-wrap">
            {[["in_app", "In-app"], ["email", "Email"], ["push", "Push"]].map(([k, label]) => (
              <FilterPill key={k}
                tone={channels[k] ? "brand" : "neutral"}
                onClick={() => patchChannels({ [k]: !channels[k] })}>
                <span className="material-icons-outlined text-xs align-middle mr-1">
                  {channels[k] ? "check_box" : "check_box_outline_blank"}
                </span>{label}
              </FilterPill>
            ))}
          </div>
        </Section>

        {/* Severity + days_before */}
        <Section title="Trigger" hint={isTimeBased ? "Time-based event — choose how many days in advance to send." : "Severity flag is read by the worker; high may bypass some rate limits later."}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Severity</label>
              <Select value={draft.severity || "normal"} onChange={e => patch({ severity: e.target.value })}>
                {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>)}
              </Select>
            </div>
            {isTimeBased && (
              <div>
                <label className="text-xs text-neutral-500 mb-1 block">Days before event</label>
                <Input type="number" min="0" max="120" value={draft.days_before ?? ""} onChange={e => patch({ days_before: e.target.value })} placeholder="e.g. 3" />
              </div>
            )}
          </div>
        </Section>

        {/* Recipients */}
        <Section title="Recipients" hint="At least one is required for the rule to deliver. Mix and match roles, contextual stand-ins, and literal addresses.">
          <RecipientList
            label="Primary recipients (To:)"
            entries={draft.custom_recipients || []}
            onChange={v => patch({ custom_recipients: v })}
            allowPresets
          />
          <RecipientList
            label="Cc"
            entries={draft.cc || []}
            onChange={v => patch({ cc: v })}
            allowPresets
            literalsOnlyHint="Cc is usually a literal address (legal@, finance@, etc.)"
          />
          <RecipientList
            label="Bcc"
            entries={draft.bcc || []}
            onChange={v => patch({ bcc: v })}
            allowPresets
            literalsOnlyHint="Bcc is hidden from the To/Cc list."
          />
        </Section>

        {/* Quiet hours */}
        <Section title="Quiet hours" hint="Within this window, we defer delivery until the window ends. Leave both blank to send immediately, any time.">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Start</label>
              <Input type="time" value={draft.quiet_hours_start || ""} onChange={e => patch({ quiet_hours_start: e.target.value || null })} />
            </div>
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">End</label>
              <Input type="time" value={draft.quiet_hours_end || ""} onChange={e => patch({ quiet_hours_end: e.target.value || null })} />
            </div>
            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Timezone</label>
              <Select value={draft.quiet_hours_tz || "America/New_York"} onChange={e => patch({ quiet_hours_tz: e.target.value })}>
                {TZ_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </Select>
            </div>
          </div>
          {draft.quiet_hours_start && draft.quiet_hours_end && draft.quiet_hours_start === draft.quiet_hours_end && (
            <div className="text-xs text-warn-600 mt-2">Start and end are equal — that means "always quiet" (rule will never deliver). Pick different times.</div>
          )}
        </Section>

        {/* Templates */}
        <Section title="Email content" hint="Use {{tokens}} below to insert dynamic values. Leave subject or body blank to use the default template.">
          <div className="mb-3">
            <label className="text-xs text-neutral-500 mb-1 block">Subject</label>
            <Input value={draft.subject_template || ""} onChange={e => patch({ subject_template: e.target.value })} placeholder="Default: " />
          </div>
          <div className="mb-3">
            <label className="text-xs text-neutral-500 mb-1 block">Body</label>
            <Textarea rows={6} value={draft.template || ""} onChange={e => patch({ template: e.target.value })} placeholder="Default body — leave blank to use." />
          </div>
          <div className="text-xs text-neutral-500 mb-2">
            Available variables:
            <div className="flex flex-wrap gap-1 mt-1">
              {(eventMeta?.vars || []).map(v => (
                <code key={v} className="text-[11px] font-mono bg-neutral-100 text-neutral-700 px-1.5 py-0.5 rounded cursor-pointer hover:bg-neutral-200"
                  onClick={() => navigator.clipboard?.writeText("{{" + v + "}}")}
                  title="Click to copy">{"{{" + v + "}}"}</code>
              ))}
            </div>
          </div>
          {(draft.subject_template || draft.template) && (
            <Card padding="p-3" className="bg-neutral-50/50 border-neutral-200">
              <div className="text-[11px] font-semibold text-neutral-500 uppercase mb-1">Preview (sample data)</div>
              {draft.subject_template && (
                <div className="text-sm font-semibold text-neutral-800 mb-2">{previewSubject}</div>
              )}
              {draft.template && (
                <div className="text-sm text-neutral-700 whitespace-pre-wrap">{previewBody}</div>
              )}
            </Card>
          )}
        </Section>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 mt-4 pt-4 border-t border-neutral-200">
        <Btn variant="secondary" size="sm" onClick={handleSendTest} disabled={testing || !channels.email}>
          {testing ? "Sending..." : "Send test to me"}
        </Btn>
        <div className="flex gap-2">
          <Btn variant="secondary" size="sm" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save rule"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function normalizeDraft(setting) {
  if (!setting) return defaultsForType("");
  const channelsRaw = setting.channels;
  let channels;
  if (typeof channelsRaw === "string") { try { channels = JSON.parse(channelsRaw); } catch { channels = { in_app: true, email: true, push: true }; } }
  else channels = channelsRaw || { in_app: true, email: true, push: true };
  return {
    enabled: setting.enabled !== false,
    channels,
    recipients: setting.recipients || "all",
    custom_recipients: parseJsonField(setting.custom_recipients) || [],
    cc: parseJsonField(setting.cc) || [],
    bcc: parseJsonField(setting.bcc) || [],
    quiet_hours_start: setting.quiet_hours_start || null,
    quiet_hours_end: setting.quiet_hours_end || null,
    quiet_hours_tz: setting.quiet_hours_tz || "America/New_York",
    severity: setting.severity || "normal",
    subject_template: setting.subject_template || "",
    template: setting.template || "",
    days_before: setting.days_before == null ? "" : setting.days_before,
  };
}

function parseJsonField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
  return null;
}

function Section({ title, hint, children }) {
  return (
    <div>
      <div className="text-sm font-semibold text-neutral-800 mb-1">{title}</div>
      {hint && <div className="text-xs text-neutral-500 mb-2">{hint}</div>}
      {children}
    </div>
  );
}

function ToggleSwitch({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} className={"relative w-11 h-6 rounded-full transition-colors " + (on ? "bg-positive-500" : "bg-neutral-300")}>
      <div className={"absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform " + (on ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

function RecipientList({ label, entries, onChange, allowPresets, literalsOnlyHint }) {
  const [showPresets, setShowPresets] = useState(false);
  const [literal, setLiteral] = useState("");

  function addEntry(entry) {
    if (entries.some(e => e.kind === entry.kind && (e.value || null) === (entry.value || null))) return;
    onChange([...entries, entry]);
  }
  function removeAt(idx) {
    onChange(entries.filter((_, i) => i !== idx));
  }
  function addLiteral() {
    const v = literal.trim().toLowerCase();
    if (!v || !v.includes("@")) return;
    addEntry({ kind: "email", value: v });
    setLiteral("");
  }

  return (
    <div className="mb-3">
      <label className="text-xs text-neutral-500 mb-1 block">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {entries.length === 0 && <span className="text-xs text-neutral-400 italic">None</span>}
        {entries.map((e, i) => (
          <span key={i} className="inline-flex items-center gap-1 bg-brand-50 border border-brand-200 text-brand-700 text-xs px-2 py-1 rounded-full">
            {entryLabel(e)}
            <button onClick={() => removeAt(i)} className="text-brand-500 hover:text-danger-600">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5 items-center flex-wrap">
        {allowPresets && (
          <Btn variant="secondary" size="xs" onClick={() => setShowPresets(s => !s)}>
            + Add role / context
          </Btn>
        )}
        <div className="flex gap-1.5 items-center">
          <Input size="sm" placeholder="email@example.com" value={literal} onChange={e => setLiteral(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addLiteral())} className="w-56" />
          <Btn variant="secondary" size="xs" onClick={addLiteral}>+ Email</Btn>
        </div>
      </div>
      {literalsOnlyHint && <div className="text-[11px] text-neutral-400 mt-1">{literalsOnlyHint}</div>}
      {showPresets && (
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1">
          {RECIPIENT_PRESETS.map((p, i) => (
            <button key={i} onClick={() => { addEntry({ kind: p.kind, value: p.value }); setShowPresets(false); }}
              className="text-left bg-white border border-neutral-200 hover:border-brand-300 rounded-lg px-3 py-2">
              <div className="text-xs font-semibold text-neutral-800">{p.label}</div>
              <div className="text-[11px] text-neutral-500">{p.explain}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function entryLabel(e) {
  if (!e) return "";
  if (e.kind === "email" || e.kind === "user") return e.value || "(empty)";
  const map = {
    role: "Role: " + (e.value || "?"),
    tenant: "Tenant of record",
    owner: "Owner of record",
    manager: "Manager of record",
    property_manager: "Property's manager",
  };
  return map[e.kind] || e.kind;
}
