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
  // Check if this notification type is enabled and which channels are active
  const { data: settings } = await supabase.from("notification_settings")
  .select("enabled, channels, recipient_filter")
  .eq("company_id", companyId).eq("type", type).maybeSingle();

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

  // Queue for push if push channel is enabled
  if (channels.push) {
  // Find push subscriptions for this recipient
  const { data: subs } = await supabase.from("push_subscriptions")
  .select("subscription").eq("company_id", companyId).eq("user_email", recipientEmail.toLowerCase());
  // Push delivery would be handled by the Edge Function
  // For now, log that push was requested
  if (subs?.length > 0) {
  // Push queued (debug removed)
  }
  }
  } catch (e) { pmError("PM-8006", { raw: e, context: "queue notification", silent: true }); }
}
