import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, PageHeader } from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, formatCurrency, normalizeEmail, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { StatCard, Spinner } from "./shared";

function EmailNotifications({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [settings, setSettings] = useState([]);
  const [logs, setLogs] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [leases, setLeases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("activity");
  const [showTest, setShowTest] = useState(null);
  const [queueStats, setQueueStats] = useState({ pending: 0, sent: 0, failed: 0 });

  const fetchQueueStatus = useCallback(async () => {
  try {
  const { data: items } = await supabase.from("notification_queue").select("status").eq("company_id", companyId).limit(500);
  if (items) {
  setQueueStats({
  pending: items.filter(i => i.status === "pending").length,
  sent: items.filter(i => i.status === "sent").length,
  failed: items.filter(i => i.status === "failed").length,
  });
  }
  } catch (e) { pmError("PM-8006", { raw: e, context: "fetch notification queue status", silent: true }); }
  }, [companyId]);

  const channels = ["in_app", "email", "push"];
  const channelLabels = { in_app: "In-App", email: "Email", push: "Push" };

  const eventLabels = {
  rent_due: { label: "Rent Due Reminder", icon: "💰", desc: "Sent X days before rent is due" },
  rent_overdue: { label: "Rent Overdue Notice", icon: "\u26a0\ufe0f", desc: "Sent when rent is past due" },
  lease_expiring: { label: "Lease Expiration Alert", icon: "\ud83d\udcdd", desc: "Sent X days before lease expires" },
  work_order_update: { label: "Work Order Status Update", icon: "🔧", desc: "Sent when maintenance request changes status" },
  payment_received: { label: "Payment Confirmation", icon: "\u2705", desc: "Sent when payment is recorded" },
  lease_created: { label: "New Lease Created", icon: "\ud83c\udfe0", desc: "Sent when a new lease is signed" },
  insurance_expiring: { label: "Vendor Insurance Alert", icon: "\ud83d\udee1\ufe0f", desc: "Sent when vendor insurance is expiring" },
  inspection_due: { label: "Inspection Reminder", icon: "\ud83d\udd0d", desc: "Sent before scheduled inspection" },
  message_received: { label: "New Message", icon: "\ud83d\udcac", desc: "Sent when a tenant or landlord sends a chat message" },
  approval_pending: { label: "Approval Needed", icon: "\ud83d\udd14", desc: "Sent to the routed approver when a change or document exception is requested" },
  };

  // Recent activity — every addNotification() call writes a row to
  // notification_inbox. Surfacing the full history here solves the
  // "bell shows 2-3 things and then nothing tracks the rest" problem:
  // the bell is a short transient list capped at 50; this feed is
  // the persistent record.
  const [activity, setActivity] = useState([]);
  const fetchData = useCallback(async () => {
  setLoading(true);
  // Activity feed is per-user, not per-company. Every notification
  // row carries a recipient_email; viewers only see rows addressed to
  // them (or company-wide broadcasts with a NULL recipient). Without
  // this filter the tab would leak each user's private inbox to
  // every admin who opens the page.
  const myEmail = userProfile?.email || "";
  const [s, l, t, le, inbox] = await Promise.all([
  supabase.from("notification_settings").select("*").eq("company_id", companyId).order("event_type"),
  supabase.from("notification_log").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100),
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("leases").select("*").eq("company_id", companyId).eq("status", "active"),
  supabase.from("notification_inbox").select("*").eq("company_id", companyId)
    .or("recipient_email.ilike." + escapeFilterValue(myEmail || "none") + ",recipient_email.is.null")
    .order("created_at", { ascending: false }).limit(200),
  ]);
  setSettings(s.data || []);
  setLogs(l.data || []);
  setTenants(t.data || []);
  setLeases(le.data || []);
  setActivity(inbox.data || []);
  setLoading(false);
  }, [companyId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function toggleSetting(setting) {
  const { error: _err6051 } = await supabase.from("notification_settings").update({ enabled: !setting.enabled }).eq("company_id", companyId).eq("id", setting.id);
  if (_err6051) pmError("PM-8006", { raw: _err6051, context: "notification_settings write", silent: true });
  fetchData();
  }

  async function updateDaysBefore(setting, days) {
  const { error: _err6056 } = await supabase.from("notification_settings").update({ days_before: Number(days) }).eq("company_id", companyId).eq("id", setting.id);
  if (_err6056) pmError("PM-8006", { raw: _err6056, context: "notification_settings write", silent: true });
  fetchData();
  }

  async function updateTemplate(setting, template) {
  const { error: _err6061 } = await supabase.from("notification_settings").update({ template }).eq("company_id", companyId).eq("id", setting.id);
  if (_err6061) pmError("PM-8006", { raw: _err6061, context: "notification_settings write", silent: true });
  }

  async function sendTestNotification(setting) {
  // Simulate sending by logging it
  const testRecipient = userProfile?.email || "test@example.com";
  const { error: _err_notification_log_6067 } = await supabase.from("notification_log").insert([{ company_id: companyId,
  event_type: setting.event_type,
  recipient_email: normalizeEmail(testRecipient),
  subject: "[TEST] " + (eventLabels[setting.event_type]?.label || setting.event_type),
  message: setting.template || "Test notification",
  status: "sent",
  related_id: "test",
  }]);
  if (_err_notification_log_6067) pmError("PM-8006", { raw: _err_notification_log_6067, context: "notification_log write", silent: true });
  addNotification("\u2709\ufe0f", "Test notification sent for " + (eventLabels[setting.event_type]?.label || setting.event_type));
  fetchData();
  }

  async function runNotificationCheck() {
  const today = new Date();
  let count = 0;

  // Check rent due
  const rentDueSetting = settings.find(s => s.event_type === "rent_due" && s.enabled);
  if (rentDueSetting) {
  const daysBefore = rentDueSetting.days_before || 3;
  for (const lease of leases) {
  const rawDueDay = lease.payment_due_day || 1;
  // Clamp due day to valid day for this month (avoids Feb 30 etc)
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dueDay = Math.min(rawDueDay, daysInMonth);
  const nextDue = new Date(today.getFullYear(), today.getMonth(), dueDay);
  if (nextDue < today) {
  nextDue.setMonth(nextDue.getMonth() + 1);
  // Re-clamp for next month (e.g., due day 31 in Feb → 28)
  const nextMonthDays = new Date(nextDue.getFullYear(), nextDue.getMonth() + 1, 0).getDate();
  if (nextDue.getDate() > nextMonthDays) nextDue.setDate(nextMonthDays);
  }
  const daysUntilDue = Math.ceil((nextDue - today) / 86400000);
  if (daysUntilDue <= daysBefore && daysUntilDue >= 0) {
  const tenant = tenants.find(t => t.name === lease.tenant_name);
  if (tenant?.email) {
  // Check if already notified for this period (prevent duplicate reminders)
  const monthKey = nextDue.getFullYear() + "-" + String(nextDue.getMonth()+1).padStart(2,"0");
  const { data: existing } = await supabase.from("notification_log").select("id").eq("company_id", companyId).eq("event_type", "rent_due").eq("related_id", lease.id).ilike("message", "%" + escapeFilterValue(monthKey) + "%").limit(1);
  if (existing?.length > 0) continue; // Already sent for this period
  
  const msg = "Rent of $" + lease.rent_amount + " is due on " + nextDue.toLocaleDateString() + " for " + lease.property;
  // Queue for email delivery
  queueNotification("rent_due", tenant.email, { tenant: lease.tenant_name, amount: lease.rent_amount, date: nextDue.toLocaleDateString(), property: lease.property }, companyId);
  // In-app notification
  addNotification("💰", "Rent reminder sent to " + tenant.name, { type: "rent_due", recipient: tenant.email });
  // Log
  const { error: _err6104 } = await supabase.from("notification_log").insert([{ company_id: companyId, event_type: "rent_due", recipient_email: normalizeEmail(tenant.email), subject: "Rent Due Reminder", message: msg + " " + monthKey, status: "queued", related_id: lease.id }]);
  if (_err6104) pmError("PM-8006", { raw: _err6104, context: "notification_log write", silent: true });
  count++;
  }
  }
  }
  }

  // Check lease expiring
  const leaseExpSetting = settings.find(s => s.event_type === "lease_expiring" && s.enabled);
  if (leaseExpSetting) {
  const daysBefore = leaseExpSetting.days_before || 60;
  for (const lease of leases) {
  const daysLeft = Math.ceil((parseLocalDate(lease.end_date) - today) / 86400000);
  if (daysLeft <= daysBefore && daysLeft > 0) {
  const tenant = tenants.find(t => t.name === lease.tenant_name);
  if (tenant?.email) {
  // Check if already notified for this lease expiry
  const { data: existingLease } = await supabase.from("notification_log").select("id").eq("company_id", companyId).eq("event_type", "lease_expiring").eq("related_id", lease.id).limit(1);
  if (existingLease?.length > 0) continue;
  
  const msg = "Lease for " + lease.property + " expires on " + lease.end_date + " (" + daysLeft + " days remaining)";
  queueNotification("lease_expiry", tenant.email, { tenant: lease.tenant_name, property: lease.property, date: lease.end_date, daysLeft }, companyId);
  addNotification("📋", "Lease expiry warning sent to " + tenant.name, { type: "lease_expiry", recipient: tenant.email });
  const { error: _err6121 } = await supabase.from("notification_log").insert([{ company_id: companyId, event_type: "lease_expiring", recipient_email: normalizeEmail(tenant.email), subject: "Lease Expiration Notice", message: msg, status: "queued", related_id: lease.id }]);
  if (_err6121) pmError("PM-8006", { raw: _err6121, context: "notification_log write", silent: true });
  count++;
  }
  }
  }
  }

  addNotification("\ud83d\udce8", count + " notifications sent");
  logAudit("create", "notifications", "Ran notification check: " + count + " sent", "", userProfile?.email, userRole, companyId);
  fetchData();
  }

  useEffect(() => { fetchQueueStatus(); }, [fetchQueueStatus]);

  if (loading) return <Spinner />;

  const sentToday = logs.filter(l => l.created_at && new Date(l.created_at).toDateString() === new Date().toDateString()).length;
  const enabledCount = settings.filter(s => s.enabled).length;

  return (
  <div>
  <div className="flex justify-between items-center mb-5">
  <PageHeader title="Email Notifications" />
  <Btn size="sm" onClick={runNotificationCheck}>Run Notification Check</Btn>
  </div>

  <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
  <StatCard label="Active Rules" value={enabledCount + "/" + settings.length} color="text-positive-600" sub="notification types" />
  <StatCard label="Sent Today" value={sentToday} color="text-info-600" sub="notifications" />
  <StatCard label="Total Sent" value={logs.length} color="text-brand-600" sub="all time" />
  <StatCard label="Failed" value={logs.filter(l => l.status === "failed").length} color={logs.filter(l => l.status === "failed").length > 0 ? "text-danger-500" : "text-neutral-400"} sub="delivery errors" />
  </div>

  {/* Queue Delivery Status */}
  <div className="bg-white rounded-xl border border-subtle-100 p-4 mb-5">
  <div className="text-sm font-semibold text-subtle-700 mb-2">📬 Notification Queue</div>
  <div className="grid grid-cols-3 gap-3">
  <div className="text-center"><div className="text-lg font-bold text-warn-600">{queueStats.pending}</div><div className="text-xs text-subtle-400">Pending</div></div>
  <div className="text-center"><div className="text-lg font-bold text-positive-600">{queueStats.sent}</div><div className="text-xs text-subtle-400">Delivered</div></div>
  <div className="text-center"><div className="text-lg font-bold text-danger-600">{queueStats.failed}</div><div className="text-xs text-subtle-400">Failed</div></div>
  </div>
  {queueStats.failed > 0 && <div className="bg-danger-50 rounded-lg px-3 py-2 mt-3 text-xs text-danger-700">⚠️ {queueStats.failed} notification(s) failed. Check that your delivery worker is running.</div>}
  {queueStats.pending > 10 && <div className="bg-warn-50 rounded-lg px-3 py-2 mt-3 text-xs text-warn-700">📬 {queueStats.pending} queued — delivery service may be behind.</div>}
  </div>

  <div className="flex gap-1 mb-4 border-b border-brand-50">
  {[["activity","Activity"],["settings","Settings"],["log","Send Log"],["rentroll","Rent Roll"]].map(([id,label]) => (
  <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400")}>{label}</button>
  ))}
  </div>

  {/* ACTIVITY TAB — full history of every in-app notification the
      app has emitted for this company. The header bell only holds the
      latest session's list; this feed is the persistent record.  */}
  {activeTab === "activity" && (
  <div className="space-y-2">
  {activity.length === 0 ? <div className="text-center py-8 text-neutral-400">No activity yet. As you manage properties, tenants, and payments, notifications will appear here.</div> : (
    activity.map(n => (
    <div key={n.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex items-center gap-3">
    <span className="text-xl">{n.icon || "🔔"}</span>
    <div className="flex-1 min-w-0">
      <div className="text-sm text-neutral-800 truncate">{n.message}</div>
      <div className="text-xs text-neutral-400">{new Date(n.created_at).toLocaleString()}{n.recipient_email ? " · " + n.recipient_email : ""}{n.notification_type && n.notification_type !== "general" ? " · " + n.notification_type : ""}</div>
    </div>
    {!n.read && <span className="text-[10px] font-bold uppercase bg-brand-100 text-brand-700 px-2 py-0.5 rounded-full">New</span>}
    </div>
    ))
  )}
  </div>
  )}

  {/* SETTINGS TAB */}
  {activeTab === "settings" && (
  <div className="space-y-3">
  {settings.map(s => {
  const info = eventLabels[s.event_type] || { label: s.event_type, icon: "\ud83d\udce7", desc: "" };
  return (
  <div key={s.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (s.enabled ? "border-brand-50" : "border-brand-50/50 opacity-60")}>
  <div className="flex justify-between items-start mb-2">
  <div className="flex items-center gap-2">
  <span className="text-lg">{info.icon}</span>
  <div>
  <div className="text-sm font-bold text-neutral-800">{info.label}</div>
  <div className="text-xs text-neutral-400">{info.desc}</div>
  </div>
  </div>
  <button onClick={() => toggleSetting(s)} className={"relative w-10 h-5 rounded-full transition-colors " + (s.enabled ? "bg-positive-500" : "bg-neutral-300")}>
  <span className={"absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow " + (s.enabled ? "left-5" : "left-0.5")} />
  </button>
  </div>
  <div className="flex items-center gap-3 text-xs mb-2">
  <span className="text-neutral-400">Recipients:</span>
  <Select value={s.recipients || "all"} onChange={async (e) => {
  // Column is `recipients` (the previous `recipient_filter` rename
  // was silently failing — column doesn't exist). Option values
  // match existing DB vocabulary: "admin" | "tenant" | "tenant,admin".
  await supabase.from("notification_settings").update({ recipients: e.target.value }).eq("id", s.id).eq("company_id", companyId);
  fetchData();
  }} className="text-xs border border-subtle-200 rounded px-1.5 py-0.5 mr-2">
  <option value="all">All</option>
  <option value="tenant">Tenant Only</option>
  <option value="admin">Admin Only</option>
  <option value="tenant,admin">Admin + Tenant</option>
  </Select>
  <div className="flex gap-1 mr-3">
  {channels.map(ch => {
  // Supabase returns JSONB columns as already-parsed JS objects; older
  // rows wrote them as serialized strings. Accept either so a mixed
  // set doesn't crash the whole Notifications page.
  const parseChannels = (x) => {
    if (!x) return { in_app: true, email: true, push: false };
    if (typeof x === 'object') return x;
    try { return JSON.parse(x); } catch { return { in_app: true, email: true, push: false }; }
  };
  const currentChannels = parseChannels(s.channels);
  return (
  <button key={ch} onClick={async () => {
  const next = { ...currentChannels, [ch]: !currentChannels[ch] };
  await supabase.from("notification_settings").update({ channels: next }).eq("id", s.id).eq("company_id", companyId);
  fetchData();
  }} className={"text-xs px-2 py-0.5 rounded " + (currentChannels[ch] ? "bg-brand-100 text-brand-700" : "bg-subtle-100 text-subtle-400")}>{channelLabels[ch]}</button>
  );
  })}
  </div>
  {s.days_before > 0 && (
  <div className="flex items-center gap-1">
  <span className="text-neutral-400">Days before:</span>
  <Input type="number" value={s.days_before} onChange={e => updateDaysBefore(s, e.target.value)} className="w-12 border border-brand-100 rounded px-1 py-0.5 text-xs text-center" min="0" />
  </div>
  )}
  </div>
  <div className="mb-2">
  <Textarea value={s.template} onChange={e => updateTemplate(s, e.target.value)} className="text-xs text-neutral-500" rows={2} />
  </div>
  <Btn variant="secondary" size="xs" onClick={() => sendTestNotification(s)}>Send Test</Btn>
  </div>
  );
  })}
  </div>
  )}

  {/* LOG TAB */}
  {activeTab === "log" && (
  <div className="space-y-2">
  {logs.map(l => (
  <div key={l.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-2.5 flex justify-between items-center">
  <div>
  <div className="text-sm text-neutral-800">{l.subject}</div>
  <div className="text-xs text-neutral-400">{l.recipient_email} · {new Date(l.created_at).toLocaleString()}</div>
  </div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (l.status === "sent" ? "bg-positive-100 text-positive-700" : l.status === "failed" ? "bg-danger-100 text-danger-700" : "bg-warn-100 text-warn-700")}>{l.status}</span>
  </div>
  ))}
  {logs.length === 0 && <div className="text-center py-8 text-neutral-400">No notifications sent yet</div>}
  </div>
  )}

  {/* RENT ROLL TAB */}
  {activeTab === "rentroll" && (
  <div>
  <h3 className="font-semibold text-neutral-700 mb-3">Rent Roll</h3>
  <div className="bg-white rounded-3xl border border-brand-50 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400">
  <tr>
  <th className="text-left px-4 py-2">Tenant</th>
  <th className="text-left px-4 py-2">Property</th>
  <th className="text-right px-4 py-2">Rent</th>
  <th className="text-right px-4 py-2">Balance</th>
  <th className="text-left px-4 py-2">Lease End</th>
  <th className="text-left px-4 py-2">Status</th>
  </tr>
  </thead>
  <tbody>
  {tenants.filter(t => t.lease_status === "active" || !t.lease_status).map(t => (
  <tr key={t.id} className="border-t border-brand-50/50">
  <td className="px-4 py-2 font-medium text-neutral-800">{t.name}</td>
  <td className="px-4 py-2 text-neutral-500">{t.property}</td>
  <td className="px-4 py-2 text-right font-bold">${safeNum(t.rent).toLocaleString()}</td>
  <td className={"px-4 py-2 text-right font-bold " + (safeNum(t.balance) > 0 ? "text-danger-600" : "text-positive-600")}>${safeNum(t.balance).toLocaleString()}</td>
  <td className="px-4 py-2 text-neutral-500">{t.move_out || "—"}</td>
  <td className="px-4 py-2"><span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (t.lease_status === "active" ? "bg-positive-100 text-positive-700" : "bg-neutral-100 text-neutral-400")}>{t.lease_status || "active"}</span></td>
  </tr>
  ))}
  </tbody>
  <tfoot className="bg-brand-50/30 font-bold text-sm">
  <tr>
  <td className="px-4 py-2" colSpan="2">Total ({tenants.filter(t => t.lease_status === "active" || !t.lease_status).length} tenants)</td>
  <td className="px-4 py-2 text-right">${tenants.filter(t => t.lease_status === "active" || !t.lease_status).reduce((s, t) => s + safeNum(t.rent), 0).toLocaleString()}</td>
  <td className="px-4 py-2 text-right">${tenants.filter(t => t.lease_status === "active" || !t.lease_status).reduce((s, t) => s + safeNum(t.balance), 0).toLocaleString()}</td>
  <td colSpan="2"></td>
  </tr>
  </tfoot>
  </table>
  </div>
  </div>
  )}
  </div>
  );
}

export { EmailNotifications };
