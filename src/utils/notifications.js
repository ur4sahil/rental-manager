import { supabase } from "../supabase";
import { pmError } from "./errors";

// ============ NOTIFICATION QUEUE ============
// Queues email notifications for async processing by Supabase Edge Function
// NOTE: queueNotification inserts into notification_queue but does NOT deliver.
// Delivery requires a separate worker (Supabase Edge Function, Cloudflare Worker, or cron job)
// that reads pending items and sends via email/SMS/push. The Notifications page shows queue status.
export async function queueNotification(type, recipientEmail, data, companyId) {
  if (!recipientEmail || !companyId) return;
  try {
  // Check if this notification type is enabled and which channels are active.
  // NOTE: column is `event_type`, not `type` — the previous filter never
  // matched, so the enabled/channels toggles in the Settings tab were no-ops.
  // `recipients` is the real column (there is no `recipient_filter`).
  const { data: settings } = await supabase.from("notification_settings")
  .select("enabled, channels, recipients")
  .eq("company_id", companyId).eq("event_type", type).maybeSingle();

  // If setting exists and is disabled, skip entirely
  if (settings && !settings.enabled) return;

  // Default push to ON when no notification_settings row exists for
  // this event_type. Push delivery is safe-by-default: /api/send-push
  // returns delivered:0 with no error when the recipient has no
  // registered subscription, so the worst case on an unsubscribed
  // user is a no-op. Leaving push:false here meant the Settings tab
  // had to be manually toggled on per event_type before any push
  // would fire — which silently dropped every tenant→staff message
  // notification until someone noticed.
  const channels = settings?.channels
  ? (typeof settings.channels === "string" ? JSON.parse(settings.channels) : settings.channels)
  : { in_app: true, email: true, push: true };

  // Queue for email if email channel is enabled
  if (channels.email) {
  const { error: _notifWriteErr } = await supabase.from("notification_queue").insert([{
  company_id: companyId,
  type,
  recipient_email: recipientEmail.toLowerCase(),
  data: typeof data === "string" ? data : JSON.stringify(data),
  status: "pending",
  }]);
  if (_notifWriteErr) pmError("PM-8006", { raw: _notifWriteErr, context: "email queue insert", silent: true });
  // Fire-and-forget the worker so the row drains immediately. Vercel
  // Hobby plan caps cron at once-per-day; the worker would otherwise
  // sit idle until the next scheduled tick (or never, if no cron is
  // wired). The worker is idempotent — concurrent calls just see no
  // pending rows. JWT auth path on the worker accepts any active
  // session, so we attach the caller's token instead of CRON_SECRET.
  else {
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (jwt) {
        fetch("/api/notification-worker", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
          body: JSON.stringify({}),
        }).catch(err => pmError("PM-8006", { raw: err, context: "worker trigger", silent: true }));
      }
    } catch (e) { pmError("PM-8006", { raw: e, context: "worker dispatch", silent: true }); }
  }
  }

  // Deliver push via the /api/send-push Vercel function. The function
  // looks up every push_subscriptions row for this (company, email),
  // dispatches with the server-side VAPID private key, and prunes
  // dead endpoints. We pass the user's Supabase JWT so the function
  // can verify the caller is an active company member — a stolen
  // service-role key alone can't push-spam from the browser.
  if (channels.push) {
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (jwt) {
        const title = pushTitleFor(type, data);
        const message = pushBodyFor(type, data);
        const url = pushUrlFor(type);
        // Fire and forget — don't block the queueNotification caller on
        // push delivery. Any failure goes to the error log silently;
        // the email/in-app queue rows still provide a delivery trail.
        fetch("/api/send-push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
          body: JSON.stringify({ company_id: companyId, user_email: recipientEmail, title, body: message, url }),
        }).catch(err => pmError("PM-8006", { raw: err, context: "push fetch", silent: true }));
      }
    } catch (e) { pmError("PM-8006", { raw: e, context: "push dispatch", silent: true }); }
  }
  } catch (e) { pmError("PM-8006", { raw: e, context: "queue notification", silent: true }); }
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
