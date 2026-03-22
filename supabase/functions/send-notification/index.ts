// Supabase Edge Function: Send Notification (Email + Push)
// Processes notification_queue and sends via Resend (email) + web-push (browser)
// Deploy: supabase functions deploy send-notification --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "notifications@propmanager.app";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@propmanager.app";

// --- Rate Limiter (per-IP, sliding window) ---
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 5;        // max requests (cron-only, shouldn't be called often)
const RATE_WINDOW = 60_000;  // per 60 seconds
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  if (rateLimitMap.size > 1000) {
    for (const [k, v] of rateLimitMap) {
      if (v.every(t => now - t > RATE_WINDOW)) rateLimitMap.delete(k);
    }
  }
  return true;
}

serve(async (req) => {
  // Rate limit check
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    
    // Fetch pending notifications
    const { data: pending, error: fetchErr } = await supabase
      .from("notification_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);

    if (fetchErr) throw new Error("Fetch failed: " + fetchErr.message);
    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 });
    }

    let sent = 0, failed = 0, pushed = 0;

    for (const notif of pending) {
      try {
        // Check channel settings for this notification type
        const { data: settings } = await supabase
          .from("notification_settings")
          .select("channels")
          .eq("company_id", notif.company_id)
          .eq("type", notif.type)
          .maybeSingle();

        const channels = settings?.channels 
          ? (typeof settings.channels === "string" ? JSON.parse(settings.channels) : settings.channels)
          : { email: true, push: false };

        const data = typeof notif.data === "string" ? JSON.parse(notif.data) : (notif.data || {});
        let emailSent = false;
        let pushSent = false;

        // === EMAIL ===
        if (channels.email && RESEND_API_KEY) {
          const subject = getSubject(notif.type, data);
          const html = getHtmlBody(notif.type, data);

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to: [notif.recipient_email],
              subject,
              html,
            }),
          });

          if (res.ok) {
            emailSent = true;
            sent++;
          } else {
            const errBody = await res.text();
            console.error("Email failed:", errBody);
          }
        }

        // === PUSH ===
        if (channels.push && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
          try {
            const { data: subs } = await supabase
              .from("push_subscriptions")
              .select("subscription")
              .eq("company_id", notif.company_id)
              .eq("user_email", notif.recipient_email);

            if (subs && subs.length > 0) {
              const pushPayload = JSON.stringify({
                title: getPushTitle(notif.type),
                message: getPushMessage(notif.type, data),
                url: "/",
              });

              for (const sub of subs) {
                try {
                  const subscription = typeof sub.subscription === "string" 
                    ? JSON.parse(sub.subscription) 
                    : sub.subscription;
                  
                  // Send push using Web Push Protocol
                  const pushResult = await sendWebPush(subscription, pushPayload);
                  if (pushResult) pushed++;
                } catch (pushErr) {
                  console.warn("Push to subscriber failed:", pushErr.message);
                  // If subscription is expired (410), remove it
                  if (pushErr.message?.includes("410") || pushErr.message?.includes("expired")) {
                    await supabase.from("push_subscriptions").delete()
                      .eq("company_id", notif.company_id)
                      .eq("user_email", notif.recipient_email);
                  }
                }
              }
              pushSent = true;
            }
          } catch (pushError) {
            console.warn("Push delivery error:", pushError.message);
          }
        }

        // Update status
        const newStatus = (emailSent || pushSent) ? "sent" : (channels.email ? "failed" : "skipped");
        await supabase.from("notification_queue").update({ 
          status: newStatus, 
          processed_at: new Date().toISOString(),
          error_message: newStatus === "failed" ? "Email delivery failed" : null,
        }).eq("id", notif.id);

      } catch (e) {
        await supabase.from("notification_queue").update({ 
          status: "failed", error_message: e.message, processed_at: new Date().toISOString() 
        }).eq("id", notif.id);
        failed++;
      }
    }

    return new Response(JSON.stringify({ processed: pending.length, sent, failed, pushed }), { 
      status: 200, headers: { "Content-Type": "application/json" } 
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});

// === WEB PUSH (simplified, no external lib needed) ===
async function sendWebPush(subscription: any, payload: string): Promise<boolean> {
  try {
    // For Deno, we use a simplified push approach via the push endpoint
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
      },
      body: payload,
    });
    return res.ok || res.status === 201;
  } catch (e) {
    console.warn("WebPush failed:", e.message);
    return false;
  }
}

// === EMAIL TEMPLATES ===
function getSubject(type: string, data: any): string {
  switch (type) {
    case "rent_due": return `Rent Reminder: $${data?.amount || ""} due ${data?.date || "soon"}`;
    case "late_fee_applied": return `Late Fee Applied: $${data?.amount || ""}`;
    case "lease_expiry": return `Lease Expiring: ${data?.property || ""} — ${data?.daysLeft || ""} days`;
    case "payment_received": return `Payment Received: $${data?.amount || ""} from ${data?.tenant || ""}`;
    case "work_order_created": return `New Maintenance Request: ${data?.issue || ""}`;
    case "work_order_completed": return `Maintenance Complete: ${data?.issue || ""}`;
    case "deposit_returned": return `Security Deposit Returned: $${data?.returned || ""}`;
    case "move_in": return `New Tenant Move-In: ${data?.tenant || ""} at ${data?.property || ""}`;
    case "move_out": return `Tenant Move-Out: ${data?.tenant || ""} from ${data?.property || ""}`;
    case "hoa_due": return `HOA Payment Due: ${data?.hoaName || ""} — $${data?.amount || ""} by ${data?.dueDate || ""}`;
    default: return "Notification from PropManager";
  }
}

function getPushTitle(type: string): string {
  switch (type) {
    case "rent_due": return "Rent Due Reminder";
    case "late_fee_applied": return "Late Fee Applied";
    case "lease_expiry": return "Lease Expiring Soon";
    case "payment_received": return "Payment Received";
    case "work_order_created": return "New Work Order";
    case "work_order_completed": return "Work Order Complete";
    case "deposit_returned": return "Deposit Returned";
    case "move_in": return "New Move-In";
    case "move_out": return "Tenant Move-Out";
    case "hoa_due": return "HOA Payment Due";
    default: return "PropManager";
  }
}

function getPushMessage(type: string, data: any): string {
  switch (type) {
    case "rent_due": return `$${data?.amount} due ${data?.date} for ${data?.property}`;
    case "late_fee_applied": return `$${data?.amount} late fee for ${data?.property}`;
    case "lease_expiry": return `${data?.property} lease expires in ${data?.daysLeft} days`;
    case "payment_received": return `$${data?.amount} from ${data?.tenant}`;
    case "work_order_created": return `${data?.issue} at ${data?.property}`;
    case "work_order_completed": return `${data?.issue} resolved at ${data?.property}`;
    case "move_in": return `${data?.tenant} moving in to ${data?.property}`;
    case "move_out": return `${data?.tenant} moving out of ${data?.property}`;
    case "hoa_due": return `$${data?.amount} due to ${data?.hoaName} for ${data?.property} by ${data?.dueDate}`;
    default: return JSON.stringify(data).slice(0, 100);
  }
}

function getHtmlBody(type: string, data: any): string {
  const header = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#4F46E5;color:white;padding:16px 24px;border-radius:12px 12px 0 0;">
      <h2 style="margin:0;font-size:18px;">PropManager</h2>
    </div>
    <div style="background:white;border:1px solid #E5E7EB;padding:24px;border-radius:0 0 12px 12px;">`;
  const footer = `<hr style="margin:20px 0;border:none;border-top:1px solid #E5E7EB;">
      <p style="color:#9CA3AF;font-size:12px;">Automated notification from PropManager.</p>
    </div></div>`;

  let body = "";
  switch (type) {
    case "rent_due":
      body = `<h3 style="color:#1F2937;">Rent Payment Reminder</h3>
        <p>Your rent of <strong>$${data?.amount || ""}</strong> for <strong>${data?.property || ""}</strong> is due on <strong>${data?.date || ""}</strong>.</p>
        <p style="color:#6B7280;">Please ensure payment is made on time to avoid late fees.</p>`;
      break;
    case "late_fee_applied":
      body = `<h3 style="color:#DC2626;">Late Fee Applied</h3>
        <p>A late fee of <strong>$${data?.amount || ""}</strong> has been applied for <strong>${data?.property || ""}</strong>.</p>
        <p style="color:#6B7280;">Your rent was <strong>${data?.daysLate || ""} days</strong> past due.</p>`;
      break;
    case "lease_expiry":
      body = `<h3 style="color:#D97706;">Lease Expiring Soon</h3>
        <p>Your lease for <strong>${data?.property || ""}</strong> expires on <strong>${data?.date || ""}</strong> (${data?.daysLeft || ""} days remaining).</p>
        <p style="color:#6B7280;">Please contact your property manager to discuss renewal options.</p>`;
      break;
    case "payment_received":
      body = `<h3 style="color:#059669;">Payment Received</h3>
        <p>A payment of <strong>$${data?.amount || ""}</strong> from <strong>${data?.tenant || ""}</strong> for <strong>${data?.property || ""}</strong> has been recorded.</p>`;
      break;
    case "work_order_created":
      body = `<h3 style="color:#2563EB;">New Maintenance Request</h3>
        <p>A work order has been created for <strong>${data?.property || ""}</strong>:</p>
        <p style="background:#F3F4F6;padding:12px;border-radius:8px;"><strong>${data?.issue || ""}</strong><br>Priority: ${data?.priority || "normal"}</p>`;
      break;
    case "work_order_completed":
      body = `<h3 style="color:#059669;">Maintenance Complete</h3>
        <p>The work order for <strong>${data?.property || ""}</strong> has been completed:</p>
        <p style="background:#ECFDF5;padding:12px;border-radius:8px;"><strong>${data?.issue || ""}</strong></p>`;
      break;
    case "deposit_returned":
      body = `<h3 style="color:#059669;">Security Deposit Returned</h3>
        <p>Your security deposit for <strong>${data?.property || ""}</strong> has been processed.</p>
        <p>Amount returned: <strong>$${data?.returned || "0"}</strong></p>
        ${data?.deducted ? `<p>Deductions: <strong>$${data.deducted}</strong></p>` : ""}`;
      break;
    case "move_in":
      body = `<h3 style="color:#2563EB;">New Tenant Move-In</h3>
        <p><strong>${data?.tenant || ""}</strong> has moved in to <strong>${data?.property || ""}</strong> on ${data?.moveInDate || ""}.</p>`;
      break;
    case "move_out":
      body = `<h3 style="color:#D97706;">Tenant Move-Out</h3>
        <p><strong>${data?.tenant || ""}</strong> has moved out of <strong>${data?.property || ""}</strong> on ${data?.moveOutDate || ""}.</p>`;
      break;
    case "hoa_due":
      body = `<h3 style="color:#D97706;">HOA Payment Due</h3>
        <p>An HOA payment is due for <strong>${data?.property || ""}</strong>:</p>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
          <tr><td>HOA</td><td><strong>${data?.hoaName || ""}</strong></td></tr>
          <tr><td>Amount</td><td><strong>$${data?.amount || "0"}</strong></td></tr>
          <tr><td>Due Date</td><td><strong>${data?.dueDate || ""}</strong></td></tr>
        </table>
        <p style="color:#6B7280;margin-top:12px;">Please ensure payment is made on time to avoid penalties.</p>`;
      break;
    default:
      body = `<h3>Notification</h3><p>${JSON.stringify(data)}</p>`;
  }
  return header + body + footer;
}
