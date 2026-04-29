import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, PageHeader, Card, Badge, FilterPill } from "../ui";
import { normalizeEmail, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { Spinner } from "./shared";

// Push subscription control. Replaces the old DevicePushPanel which
// surfaced raw permission state, the VAPID endpoint URL, and a 4-button
// debug bar — accurate but read like a DevTools console. The actual
// auto-subscribe still runs silently from App.js:registerPushNotifications
// on login; this panel is for the manual re-enable / test / disable
// flow when something went wrong silently.
function DevicePushPanel({ companyId, userProfile, showToast }) {
  const [state, setState] = useState({ permission: "unknown", subscribed: false, endpoint: null, log: [], health: null });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    const permission = (typeof Notification !== "undefined") ? Notification.permission : "unsupported";
    let subscribed = false, endpoint = null;
    try {
      const reg = await navigator.serviceWorker.getRegistration?.();
      if (reg?.pushManager) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { subscribed = true; endpoint = sub.endpoint; }
      }
    } catch (_e) { /* not supported */ }
    // Pull health from server: when did the SW last beacon back?
    // null/old means Apple silently revoked; user should re-enable.
    let health = null;
    try {
      if (companyId && userProfile?.email) {
        const { data } = await supabase.from("push_subscriptions")
          .select("last_sw_received_at, last_dispatch_at, dead_marked_at, created_at")
          .eq("company_id", companyId).eq("user_email", userProfile.email)
          .maybeSingle();
        health = data || null;
      }
    } catch (_e) { /* best effort */ }
    setState(s => ({ ...s, permission, subscribed, endpoint, health }));
  }, [companyId, userProfile?.email]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleEnable() {
    if (busy) return;
    setBusy(true);
    const log = [];
    const add = (line) => log.push(new Date().toLocaleTimeString() + " " + line);
    try {
      add("Checking browser support…");
      if (!("serviceWorker" in navigator)) { add("❌ service worker not supported"); throw new Error("service worker unsupported"); }
      if (!("PushManager" in window)) { add("❌ push manager not supported"); throw new Error("push unsupported"); }
      add("✓ browser supports push");

      add("Registering /sw.js…");
      const registration = await navigator.serviceWorker.register("/sw.js");
      add("✓ service worker registered");

      add("Requesting Notification permission…");
      const permission = await Notification.requestPermission();
      add(permission === "granted" ? "✓ permission granted" : "❌ permission " + permission);
      if (permission !== "granted") throw new Error("permission " + permission);

      const key = process.env.REACT_APP_VAPID_PUBLIC_KEY || "";
      if (!key) { add("❌ VAPID key missing from build"); throw new Error("VAPID key missing"); }
      add("✓ VAPID public key present");

      const padding = "=".repeat((4 - key.length % 4) % 4);
      const base64 = (key + padding).replace(/-/g, "+").replace(/_/g, "/");
      const rawData = window.atob(base64);
      const applicationServerKey = Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));

      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        add("Existing subscription — unsubscribing first (VAPID rotation safe)");
        try { await existing.unsubscribe(); } catch (_e) { add("⚠︎ unsubscribe refused — continuing"); }
      }

      add("Subscribing…");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      add("✓ subscribed");

      add("Saving subscription…");
      const { error } = await supabase.from("push_subscriptions").upsert([{
        company_id: companyId,
        user_email: userProfile?.email,
        subscription: JSON.parse(JSON.stringify(subscription)),
      }], { onConflict: "company_id,user_email" });
      if (error) { add("❌ save failed: " + error.message); throw error; }
      add("✓ saved — push is live on this device");
      if (showToast) showToast("Push notifications turned on for this device.", "success");
      await refresh();
    } catch (e) {
      add("ERROR: " + (e?.message || "unknown"));
      if (showToast) showToast("Couldn't turn on notifications: " + (e?.message || "unknown"), "error");
    } finally {
      setState(s => ({ ...s, log }));
      setBusy(false);
    }
  }

  async function handleTest() {
    if (!userProfile?.email || !companyId) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (!jwt) { showToast("Not signed in — can't test", "error"); return; }
      const res = await fetch("/api/notifications?action=push", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({ company_id: companyId, user_email: userProfile.email, title: "Housify test", body: "Push is working on this device.", url: "/#notifications" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { showToast("Test push failed: " + (j.error || res.status), "error"); return; }
      showToast(j.delivered > 0 ? "Test push delivered." : "Test push sent but not delivered yet.", j.delivered > 0 ? "success" : "warning");
    } catch (e) {
      showToast("Test push failed: " + e.message, "error");
    }
  }

  async function handleDisable() {
    if (busy) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration?.();
      const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        try { await sub.unsubscribe(); } catch (_e) { /* harmless if already gone */ }
      }
      await supabase.from("push_subscriptions").delete()
        .eq("company_id", companyId)
        .ilike("user_email", escapeFilterValue(userProfile?.email || ""));
      showToast?.("Push notifications turned off for this device.", "success");
      await refresh();
    } catch (e) {
      showToast?.("Couldn't turn off notifications: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  // Permission denied falls through to the hero card below, which
  // shows a "Try again" button + contextual instructions for both
  // browser-blocked and not-yet-prompted states. Earlier this early-
  // returned with text only, leaving denied users no actionable button.

  // Subscribed — confirmation row + health detail.
  // Apple silently revokes web push permissions when the SW fails to
  // call showNotification (the "silent push" trap). When that
  // happens, browser-side getSubscription() still returns a sub, the
  // server still gets 201 from APNS, and the user has no idea their
  // pushes are dead. We track health server-side via the SW beacon
  // (last_sw_received_at). Show the user the truth.
  if (state.subscribed) {
    const h = state.health;
    const lastRecv = h?.last_sw_received_at ? new Date(h.last_sw_received_at).getTime() : 0;
    const lastDispatch = h?.last_dispatch_at ? new Date(h.last_dispatch_at).getTime() : 0;
    const subAge = h?.created_at ? Date.now() - new Date(h.created_at).getTime() : 0;
    const daysSinceRecv = lastRecv ? Math.floor((Date.now() - lastRecv) / 86400000) : null;
    // Suspect cases — any of the following:
    //   1. Browser has a sub locally but server has no row → the
    //      DB row was wiped (admin reset, expired sweep) and the
    //      App.js auto-resubscribe didn't kick in for some reason.
    //   2. Server marked the sub dead (>7d without SW beacon).
    //   3. Sub has been receiving dispatches >7d with zero beacons.
    //   4. Last beacon was >7d ago.
    const SEVEN_DAYS = 7 * 86400000;
    const dbRowMissing = !h;
    const dbDeadFlag = !!h?.dead_marked_at;
    const neverAcked = !lastRecv && lastDispatch > 0 && subAge > SEVEN_DAYS;
    const stale = lastRecv > 0 && (Date.now() - lastRecv) > SEVEN_DAYS;
    const suspect = dbRowMissing || dbDeadFlag || neverAcked || stale;
    const tone = suspect ? "warn" : "positive";
    const palette = suspect
      ? { bg: "bg-warn-50/40", border: "border-warn-200", text: "text-warn-800", icon: "warning" }
      : { bg: "bg-positive-50/40", border: "border-positive-200", text: "text-positive-800", icon: "check_circle" };
    const lastRecvLabel = dbRowMissing
      ? "This device's subscription is missing on the server — tap Re-enable."
      : !lastRecv
      ? (lastDispatch > 0 ? "Never received — your device may have stopped accepting them." : "No pushes sent yet — wait for the next event.")
      : daysSinceRecv === 0 ? "Last received: today"
      : daysSinceRecv === 1 ? "Last received: yesterday"
      : "Last received: " + daysSinceRecv + " days ago";
    return (
      <Card padding="p-4" className={"mb-5 " + palette.bg + " " + palette.border}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className={"flex items-center gap-2 text-sm " + palette.text}>
              <span className="material-icons-outlined text-base">{palette.icon}</span>
              <span className="font-semibold">{suspect ? "Push notifications appear broken" : "Notifications are on for this device"}</span>
            </div>
            <div className={"text-xs mt-1 " + palette.text + " opacity-80"}>{lastRecvLabel}</div>
            {suspect && (
              <div className="text-xs text-neutral-600 mt-2">
                Apple silently disables push notifications for installed PWAs after certain failure conditions. Tap <strong>Re-enable</strong> to register a fresh subscription.
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap shrink-0">
            <Btn onClick={handleTest} disabled={busy} variant="secondary" size="xs">Send test</Btn>
            {suspect && <Btn onClick={handleEnable} disabled={busy} variant="primary" size="xs">{busy ? "Working…" : "Re-enable"}</Btn>}
            <Btn onClick={handleDisable} disabled={busy} variant="secondary" size="xs">Turn off</Btn>
          </div>
        </div>
      </Card>
    );
  }

  // Not subscribed — prominent hero card. Always shows the OS-level
  // permission prompt button so users can tap it any time, including
  // after they previously dismissed the auto-prompt at login.
  return (
    <Card padding="p-5" className="mb-5 border-brand-200 bg-brand-50/40">
      <div className="flex items-start gap-3">
        <span className="material-icons-outlined text-brand-600 text-2xl">notifications_active</span>
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-neutral-800 mb-1">Turn on push notifications</div>
          <div className="text-sm text-neutral-600 mb-3">
            Get instant alerts on this device when a tenant pays, sends a message, or files a maintenance request.
            {state.permission === "denied" && (
              <span className="block mt-2 text-warn-700 text-xs">
                Notifications are blocked at the browser level. Open your browser's site settings for this page → Notifications → Allow, then tap the button below to subscribe.
              </span>
            )}
          </div>
          <Btn onClick={handleEnable} disabled={busy} size="lg">
            {busy ? "Requesting permission…" : (state.permission === "denied" ? "Try again" : "Allow notifications")}
          </Btn>
          {/iPhone|iPad|iPod/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") && (
            <div className="mt-3 text-xs text-neutral-500">
              <strong>iPhone / iPad:</strong> notifications only work when Housify is added to your home screen.
              In Safari, tap Share → "Add to Home Screen", open the app from there, then tap Allow notifications.
            </div>
          )}
        </div>
      </div>
      {state.log.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-neutral-400 cursor-pointer hover:text-neutral-600">Show technical details</summary>
          <pre className="mt-2 bg-neutral-50 rounded-lg p-3 text-[11px] text-neutral-600 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">{state.log.join("\n")}</pre>
        </details>
      )}
    </Card>
  );
}

// Day bucket for grouping Activity / History rows. Returns "Today",
// "Yesterday", or "Earlier" — matches macOS Mail / iOS conventions
// rather than absolute dates, which read more friendly for a feed.
function dayBucket(iso) {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  if (isNaN(d)) return "Earlier";
  const startOfDay = (x) => { const c = new Date(x); c.setHours(0, 0, 0, 0); return c; };
  const today = startOfDay(new Date());
  const dDay = startOfDay(d);
  const days = Math.round((today - dDay) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}

function groupByDay(items, dateKey = "created_at") {
  const groups = { Today: [], Yesterday: [], Earlier: [] };
  for (const r of items) groups[dayBucket(r[dateKey])].push(r);
  return groups;
}

function EmailNotifications({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [settings, setSettings] = useState([]);
  const [logs, setLogs] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("activity");
  const [activityFilter, setActivityFilter] = useState("all"); // "all" | "unread"
  const [queueFailed, setQueueFailed] = useState(0);

  // Dropped: tenants / leases / queueStats.pending+sent — the page no
  // longer surfaces those. Queue-failed count is kept only to drive the
  // single conditional inline alert at the top.
  const fetchQueueFailed = useCallback(async () => {
    try {
      const { count } = await supabase.from("notification_queue")
        .select("*", { count: "exact", head: true })
        .eq("company_id", companyId).eq("status", "failed");
      setQueueFailed(count || 0);
    } catch (e) { pmError("PM-8006", { raw: e, context: "fetch notification queue failed count", silent: true }); }
  }, [companyId]);

  const channels = ["in_app", "email", "push"];
  const channelLabels = { in_app: "In-app", email: "Email", push: "Push" };

  const eventLabels = {
    rent_due:           { label: "Rent due reminder",        icon: "💰", desc: "Sent before rent is due" },
    rent_overdue:       { label: "Rent overdue notice",      icon: "⚠️", desc: "Sent when rent is past due" },
    lease_expiring:     { label: "Lease expiration alert",   icon: "📝", desc: "Sent before a lease expires" },
    work_order_update:  { label: "Work order update",        icon: "🔧", desc: "When maintenance status changes" },
    payment_received:   { label: "Payment confirmation",     icon: "✅", desc: "When a payment is recorded" },
    lease_created:      { label: "New lease created",        icon: "🏠", desc: "When a new lease is signed" },
    insurance_expiring: { label: "Vendor insurance alert",   icon: "🛡️", desc: "When vendor insurance is expiring" },
    inspection_due:     { label: "Inspection reminder",      icon: "🔍", desc: "Before a scheduled inspection" },
    message_received:   { label: "New message",              icon: "💬", desc: "When a tenant or landlord sends a message" },
    approval_pending:   { label: "Approval needed",          icon: "🔔", desc: "When a change or document exception is requested" },
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Activity feed is per-user — every notification row carries a
    // recipient_email. Without filtering, the tab would leak each
    // user's inbox to every admin.
    const myEmail = userProfile?.email || "";
    const [s, l, inbox] = await Promise.all([
      supabase.from("notification_settings").select("*").eq("company_id", companyId).order("event_type"),
      supabase.from("notification_log").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100),
      supabase.from("notification_inbox").select("*").eq("company_id", companyId)
        .or("recipient_email.ilike." + escapeFilterValue(myEmail || "none") + ",recipient_email.is.null")
        .order("created_at", { ascending: false }).limit(200),
    ]);
    setSettings(s.data || []);
    setLogs(l.data || []);
    setActivity(inbox.data || []);
    setLoading(false);
  }, [companyId, userProfile?.email]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { fetchQueueFailed(); }, [fetchQueueFailed]);

  async function toggleSetting(setting) {
    const { error } = await supabase.from("notification_settings").update({ enabled: !setting.enabled }).eq("company_id", companyId).eq("id", setting.id);
    if (error) pmError("PM-8006", { raw: error, context: "notification_settings toggle", silent: true });
    fetchData();
  }

  async function updateDaysBefore(setting, days) {
    const { error } = await supabase.from("notification_settings").update({ days_before: Number(days) }).eq("company_id", companyId).eq("id", setting.id);
    if (error) pmError("PM-8006", { raw: error, context: "notification_settings days_before", silent: true });
    fetchData();
  }

  async function updateTemplate(setting, template) {
    const { error } = await supabase.from("notification_settings").update({ template }).eq("company_id", companyId).eq("id", setting.id);
    if (error) pmError("PM-8006", { raw: error, context: "notification_settings template", silent: true });
  }

  async function updateRecipients(setting, recipients) {
    const { error } = await supabase.from("notification_settings").update({ recipients }).eq("id", setting.id).eq("company_id", companyId);
    if (error) pmError("PM-8006", { raw: error, context: "notification_settings recipients", silent: true });
    fetchData();
  }

  // Supabase returns JSONB as parsed JS objects; older rows stored
  // serialized strings. Accept either so a mixed set doesn't crash.
  function parseChannels(x) {
    if (!x) return { in_app: true, email: true, push: true };
    if (typeof x === "object") return x;
    try { return JSON.parse(x); } catch { return { in_app: true, email: true, push: true }; }
  }

  async function toggleChannel(setting, ch) {
    const current = parseChannels(setting.channels);
    const next = { ...current, [ch]: !current[ch] };
    const { error } = await supabase.from("notification_settings").update({ channels: next }).eq("id", setting.id).eq("company_id", companyId);
    if (error) pmError("PM-8006", { raw: error, context: "notification_settings channels", silent: true });
    fetchData();
  }

  async function sendTestNotification(setting) {
    const testRecipient = userProfile?.email || "test@example.com";
    const { error } = await supabase.from("notification_log").insert([{
      company_id: companyId,
      event_type: setting.event_type,
      recipient_email: normalizeEmail(testRecipient),
      subject: "[TEST] " + (eventLabels[setting.event_type]?.label || setting.event_type),
      message: setting.template || "Test notification",
      status: "sent",
      related_id: "test",
    }]);
    if (error) pmError("PM-8006", { raw: error, context: "notification_log test write", silent: true });
    addNotification("✉️", "Test sent for " + (eventLabels[setting.event_type]?.label || setting.event_type));
    fetchData();
  }

  if (loading) return <Spinner />;

  // Activity filter (All / Unread)
  const filteredActivity = activityFilter === "unread" ? activity.filter(a => !a.read) : activity;
  const activityGroups = groupByDay(filteredActivity);
  const logGroups = groupByDay(logs);

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Stay up to date on rent, leases, and maintenance."
      />

      {queueFailed > 0 && (
        <div className="bg-danger-50 border border-danger-200 rounded-xl px-4 py-2.5 mb-4 text-sm text-danger-700">
          {queueFailed} notification{queueFailed === 1 ? "" : "s"} didn't deliver. Check your email settings.
        </div>
      )}

      <DevicePushPanel companyId={companyId} userProfile={userProfile} showToast={showToast} />

      <div className="flex gap-1 mb-4 border-b border-brand-50">
        {[["activity", "Activity"], ["preferences", "Preferences"], ["history", "History"]].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)}
            className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400")}>
            {label}
          </button>
        ))}
      </div>

      {/* ─── ACTIVITY ─── */}
      {activeTab === "activity" && (
        <div>
          <div className="flex gap-2 mb-4">
            <FilterPill active={activityFilter === "all"} onClick={() => setActivityFilter("all")}>
              All ({activity.length})
            </FilterPill>
            <FilterPill active={activityFilter === "unread"} onClick={() => setActivityFilter("unread")}>
              Unread ({activity.filter(a => !a.read).length})
            </FilterPill>
          </div>

          {filteredActivity.length === 0 ? (
            <div className="text-center py-12 text-neutral-400 text-sm">
              {activityFilter === "unread" ? "No unread notifications." : "No activity yet. As things happen, you'll see them here."}
            </div>
          ) : (
            ["Today", "Yesterday", "Earlier"].map(bucket => (
              activityGroups[bucket].length > 0 && (
                <div key={bucket} className="mb-5">
                  <div className="text-xs uppercase tracking-wide text-neutral-400 font-semibold mb-2 px-1">{bucket}</div>
                  <div className="space-y-2">
                    {activityGroups[bucket].map(n => (
                      <Card key={n.id} padding="px-4 py-3" className="flex items-center gap-3">
                        <span className="text-xl">{n.icon || "🔔"}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-neutral-800 truncate">{n.message}</div>
                          <div className="text-xs text-neutral-400">
                            {new Date(n.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                            {n.notification_type && n.notification_type !== "general" ? " · " + n.notification_type : ""}
                          </div>
                        </div>
                        {!n.read && <Badge color="indigo" label="New" />}
                      </Card>
                    ))}
                  </div>
                </div>
              )
            ))
          )}
        </div>
      )}

      {/* ─── PREFERENCES ─── */}
      {activeTab === "preferences" && (
        <div className="space-y-3">
          {settings.length === 0 && (
            <div className="text-center py-12 text-neutral-400 text-sm">
              No notification rules configured for this company yet.
            </div>
          )}
          {settings.map(s => {
            const info = eventLabels[s.event_type] || { label: s.event_type, icon: "📧", desc: "" };
            const ch = parseChannels(s.channels);
            return (
              <Card key={s.id} padding="p-4" className={s.enabled ? "" : "opacity-70"}>
                {/* Header row — always visible */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <span className="text-xl shrink-0">{info.icon}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-neutral-800">{info.label}</div>
                      <div className="text-xs text-neutral-400">{info.desc}</div>
                    </div>
                  </div>
                  <button onClick={() => toggleSetting(s)}
                    aria-label={(s.enabled ? "Disable " : "Enable ") + info.label}
                    className={"relative w-10 h-5 rounded-full transition-colors shrink-0 " + (s.enabled ? "bg-success-500" : "bg-neutral-300")}>
                    <span className={"absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow " + (s.enabled ? "left-5" : "left-0.5")} />
                  </button>
                </div>

                {/* Detail controls — only when enabled */}
                {s.enabled && (
                  <div className="mt-4 pt-4 border-t border-brand-50 space-y-3">
                    {/* Channels */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-neutral-500 mr-1">Send via:</span>
                      {channels.map(c => (
                        <button key={c} onClick={() => toggleChannel(s, c)}
                          className={"text-xs px-2.5 py-1 rounded-full border transition-colors " +
                            (ch[c]
                              ? "bg-brand-50 text-brand-700 border-brand-200"
                              : "bg-white text-neutral-400 border-neutral-200 hover:border-neutral-300")}>
                          {channelLabels[c]}
                        </button>
                      ))}
                    </div>

                    {/* Recipients + days_before */}
                    <div className="flex items-center gap-3 flex-wrap text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500">Recipients:</span>
                        <Select value={s.recipients || "all"} onChange={e => updateRecipients(s, e.target.value)}
                          className="text-xs border border-neutral-200 rounded-lg px-2 py-1">
                          <option value="all">Everyone</option>
                          <option value="tenant">Tenants only</option>
                          <option value="admin">Admins only</option>
                          <option value="tenant,admin">Admins + Tenants</option>
                        </Select>
                      </div>
                      {s.days_before > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="text-neutral-500">Notify</span>
                          <Input type="number" value={s.days_before} onChange={e => updateDaysBefore(s, e.target.value)}
                            className="w-14 border border-neutral-200 rounded-lg px-2 py-1 text-xs text-center" min="0" />
                          <span className="text-neutral-500">days early</span>
                        </div>
                      )}
                    </div>

                    {/* Customize message + Send test */}
                    <div className="flex items-center justify-between text-xs">
                      <details className="flex-1 mr-3">
                        <summary className="text-neutral-500 cursor-pointer hover:text-neutral-700 inline">
                          Customize message
                        </summary>
                        <Textarea value={s.template || ""} onChange={e => updateTemplate(s, e.target.value)}
                          className="text-xs text-neutral-700 mt-2" rows={3}
                          placeholder="Use {{tenant}}, {{property}}, {{amount}}, {{date}} as placeholders." />
                      </details>
                      <button onClick={() => sendTestNotification(s)}
                        className="text-brand-600 hover:underline text-xs shrink-0">
                        Send test
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ─── HISTORY ─── */}
      {activeTab === "history" && (
        <div>
          {logs.length === 0 ? (
            <div className="text-center py-12 text-neutral-400 text-sm">
              No notifications sent yet.
            </div>
          ) : (
            ["Today", "Yesterday", "Earlier"].map(bucket => (
              logGroups[bucket].length > 0 && (
                <div key={bucket} className="mb-5">
                  <div className="text-xs uppercase tracking-wide text-neutral-400 font-semibold mb-2 px-1">{bucket}</div>
                  <div className="space-y-2">
                    {logGroups[bucket].map(l => (
                      <Card key={l.id} padding="px-4 py-2.5" className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-neutral-800 truncate">{l.subject}</div>
                          <div className="text-xs text-neutral-400 truncate">
                            {l.recipient_email} · {new Date(l.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </div>
                        </div>
                        <Badge status={l.status} />
                      </Card>
                    ))}
                  </div>
                </div>
              )
            ))
          )}
        </div>
      )}
    </div>
  );
}

export { EmailNotifications };
