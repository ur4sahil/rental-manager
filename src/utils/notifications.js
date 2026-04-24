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

  const channels = settings?.channels
  ? (typeof settings.channels === "string" ? JSON.parse(settings.channels) : settings.channels)
  : { in_app: true, email: true, push: false };

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
        const title = pushTitleFor(type);
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
function pushTitleFor(type) {
  const map = {
    message_received: "New message",
    payment_received: "Payment received",
    move_out: "Move-out completed",
    deposit_returned: "Deposit returned",
    lease_expiry: "Lease expiring soon",
    maintenance_request: "Maintenance request",
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
  if (type === "message_received") return (d.sender ? d.sender + ": " : "") + (d.preview || "").slice(0, 120);
  if (type === "payment_received") return (d.tenant || "Tenant") + " — $" + (d.amount ?? "?");
  if (type === "move_out") return (d.tenant || "Tenant") + " moved out of " + (d.property || "property");
  if (type === "deposit_returned") return "$" + (d.returned ?? 0) + " returned to " + (d.tenant || "tenant");
  if (type === "maintenance_request") return (d.title || "New request") + (d.property ? " — " + d.property : "");
  return d.preview || d.message || d.description || "";
}
function pushUrlFor(type) {
  if (type === "message_received") return "/#messages";
  if (type === "payment_received") return "/#payments";
  if (type === "maintenance_request" || type === "work_order_update") return "/#maintenance";
  if (type === "approval_request") return "/#approvals";
  return "/";
}
