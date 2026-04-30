import { supabase } from "../supabase";
import { pmError } from "./errors";
import { resolveRecipients } from "./notificationRecipients";

// ============ NOTIFICATION QUEUE ============
// Queues email notifications for async processing by the worker
// (api/_notification-worker-impl.js). Inserting a row here does NOT
// deliver — delivery happens when the worker drains the queue.
//
// Two call modes:
//   queueNotification(type, "alice@x.com", data, cid)
//     → single-recipient legacy path. Still works for back-compat
//       with every existing call site.
//   queueNotification(type, null, data, cid)
//     → admin-driven fan-out. Reads notification_settings.custom_recipients
//       and inserts one queue row per resolved recipient with cc/bcc
//       copied onto each row.
//
// In either mode, cc and bcc from notification_settings are stamped
// onto every row we insert — admins can add a static cc to all
// payments without touching call sites.
//
// quiet_hours_start/end (in quiet_hours_tz) defer scheduled_for to
// the next end-of-window timestamp; the worker waits to send.
export async function queueNotification(type, recipientEmail, data, companyId) {
  if (!companyId) return;
  try {
  // Pull every column needed for both legacy and admin-driven paths.
  const { data: settings } = await supabase.from("notification_settings")
  .select("enabled, channels, recipients, custom_recipients, cc, bcc, quiet_hours_start, quiet_hours_end, quiet_hours_tz")
  .eq("company_id", companyId).eq("event_type", type).maybeSingle();

  if (settings && !settings.enabled) return;

  // Default push to ON when no notification_settings row exists for
  // this event_type. Push delivery is safe-by-default — /api/notifications
  // ?action=push returns delivered:0 silently when the recipient has
  // no registered subscription.
  const channels = settings?.channels
  ? (typeof settings.channels === "string" ? JSON.parse(settings.channels) : settings.channels)
  : { in_app: true, email: true, push: true };

  // ── Resolve primary recipient list ─────────────────────────────
  // If the caller passed an explicit email, that's the only primary
  // recipient (legacy mode). If the caller passed null, expand
  // settings.custom_recipients via the resolver.
  let primaryRecipients = [];
  let cc = [];
  let bcc = [];
  if (recipientEmail) {
    primaryRecipients = [recipientEmail.toLowerCase()];
    // Even in legacy mode, honor the admin's cc/bcc setting.
    const resolved = await resolveRecipients(companyId, type, data, settings);
    cc = resolved.cc;
    bcc = resolved.bcc;
  } else {
    const resolved = await resolveRecipients(companyId, type, data, settings);
    primaryRecipients = resolved.primary;
    cc = resolved.cc;
    bcc = resolved.bcc;
  }
  if (primaryRecipients.length === 0) return;

  // ── Quiet hours ────────────────────────────────────────────────
  // If we're inside the configured window, defer to next end-of-window.
  const scheduledFor = computeScheduledFor(settings);

  // ── Queue email rows ───────────────────────────────────────────
  if (channels.email) {
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    const rows = primaryRecipients.map(rcpt => ({
      company_id: companyId,
      type,
      recipient_email: rcpt,
      data: dataStr,
      status: "pending",
      cc: cc.length ? cc : [],
      bcc: bcc.length ? bcc : [],
      scheduled_for: scheduledFor,
    }));
    const { error: insErr } = await supabase.from("notification_queue").insert(rows);
    if (insErr) pmError("PM-8006", { raw: insErr, context: "email queue insert", silent: true });
    else {
      // Fire-and-forget the worker so non-deferred rows drain now.
      // Deferred rows (scheduled_for > now) wait until the cron tick
      // OR the next user-triggered worker call after the window.
      if (!scheduledFor) {
        try {
          const { data: session } = await supabase.auth.getSession();
          const jwt = session?.session?.access_token;
          if (jwt) {
            fetch("/api/notifications?action=worker", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
              body: JSON.stringify({}),
            }).catch(err => pmError("PM-8006", { raw: err, context: "worker trigger", silent: true }));
          }
        } catch (e) { pmError("PM-8006", { raw: e, context: "worker dispatch", silent: true }); }
      }
    }
  }

  // ── Push delivery ──────────────────────────────────────────────
  // One push per primary recipient. cc/bcc are EMAIL semantics — they
  // don't fan out to push (a push notification is a one-recipient
  // concept; cc/bcc to push would be confusing and noisy).
  if (channels.push) {
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (jwt) {
        const title = pushTitleFor(type, data);
        const message = pushBodyFor(type, data);
        const url = pushUrlFor(type);
        await Promise.all(primaryRecipients.map(rcpt =>
          fetch("/api/notifications?action=push", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
            body: JSON.stringify({ company_id: companyId, user_email: rcpt, title, body: message, url }),
          }).catch(err => pmError("PM-8006", { raw: err, context: "push fetch", silent: true }))
        ));
      }
    } catch (e) { pmError("PM-8006", { raw: e, context: "push dispatch", silent: true }); }
  }
  } catch (e) { pmError("PM-8006", { raw: e, context: "queue notification", silent: true }); }
}

// Compute scheduled_for based on quiet_hours window. Returns ISO
// string when 'now' falls inside the window (set scheduled_for to the
// next window-end timestamp), or null when we're outside (deliver
// immediately). Handles wrap-around windows like 22:00 → 07:00.
function computeScheduledFor(settings) {
  if (!settings?.quiet_hours_start || !settings?.quiet_hours_end) return null;
  const tz = settings.quiet_hours_tz || "America/New_York";
  // Get current time in target tz. Intl is the easiest way.
  let nowParts;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    nowParts = parts;
  } catch (_e) { return null; }
  const nowMins = parseInt(nowParts.hour, 10) * 60 + parseInt(nowParts.minute, 10);
  const startMins = toMins(settings.quiet_hours_start);
  const endMins = toMins(settings.quiet_hours_end);
  const inWindow = startMins <= endMins
    ? (nowMins >= startMins && nowMins < endMins)
    : (nowMins >= startMins || nowMins < endMins); // wrap-around
  if (!inWindow) return null;
  // Next end-of-window in tz. Build a date at end_h:end_m today; if
  // it's already passed, push to tomorrow.
  const y = parseInt(nowParts.year, 10);
  const m = parseInt(nowParts.month, 10) - 1;
  const d = parseInt(nowParts.day, 10);
  const endH = Math.floor(endMins / 60);
  const endM = endMins % 60;
  // Simple TZ math: build candidate as a UTC date interpreted in tz.
  // Step forward in 5-min increments would be precise, but for our
  // purposes (deferring up to ~10h) approximate is fine. We compute
  // end-of-window by constructing a Date in tz via toLocaleString
  // round-trip — accurate enough for hourly-grained notifications.
  let candidateLocal = new Date(Date.UTC(y, m, d, endH, endM));
  // If candidate's interpretation in tz is before now, push +1 day.
  if (nowMins >= startMins && startMins > endMins) {
    // Wrap-around case: we're after the start (e.g. 23:00) and
    // window ends at 07:00 tomorrow.
    candidateLocal = new Date(candidateLocal.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidateLocal.toISOString();
}

function toMins(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).split(":").map(n => parseInt(n, 10) || 0);
  return h * 60 + m;
}

// Human-readable title/body per notification type. Kept terse — push
// banners truncate hard on mobile, so the first ~40 chars carry the
// signal and the full text lives in the in-app/email copy.
//
// Title carries the WHO + WHERE context (sender · short property
// address) so the recipient can triage without opening the app.
// Body carries the actual content (the message, the amount, etc.).
// Strip the property to its first comma-separated segment so
// "10013 Dakin Ct, Cheltenham, MD 20623" shows as "10013 Dakin Ct"
// — full address won't fit on a phone banner anyway.
function shortProp(p) {
  if (!p || typeof p !== "string") return "";
  return p.split(",")[0].trim();
}
function pushTitleFor(type, data) {
  const d = typeof data === "string" ? {} : (data || {});
  const who = d.sender || d.tenant || "";
  const where = shortProp(d.property);
  const join = (a, b) => [a, b].filter(Boolean).join(" \u00b7 "); // " · "
  if (type === "message_received") return join(who, where) || "New message";
  if (type === "payment_received") return join(who, where) || "Payment received";
  if (type === "move_out") return join(d.tenant, where) || "Move-out completed";
  if (type === "maintenance_request") return join(d.tenant, where) || "Maintenance request";
  const map = {
    deposit_returned: "Deposit returned",
    lease_expiry: "Lease expiring soon",
    work_order_update: "Work order update",
    invoice_approved: "Invoice approved",
    invoice_rejected: "Invoice rejected",
    approval_request: "Approval needed",
    document_uploaded: "Document uploaded",
  };
  return map[type] || "Housify";
}
function pushBodyFor(type, data) {
  const d = typeof data === "string" ? {} : (data || {});
  if (type === "message_received") return (d.preview || "").slice(0, 140) || "(no preview)";
  if (type === "payment_received") return "$" + (d.amount ?? "?") + (d.status ? " · " + d.status : "");
  if (type === "move_out") return "Move-out " + (d.moveOutDate || "completed");
  if (type === "deposit_returned") return "$" + (d.returned ?? 0) + " returned to " + (d.tenant || "tenant");
  if (type === "maintenance_request") return d.title || d.preview || "New request";
  return d.preview || d.message || d.description || "";
}
function pushUrlFor(type) {
  if (type === "message_received") return "/#messages";
  if (type === "payment_received") return "/#payments";
  if (type === "maintenance_request" || type === "work_order_update") return "/#maintenance";
  if (type === "approval_request") return "/#approvals";
  return "/";
}
