// Supabase Edge Function: Stripe Webhook Handler
// Listens for checkout.session.completed events to update payment status
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Rate Limiter (per-IP, sliding window) ---
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 30;       // max requests (Stripe can send bursts)
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

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Rate limit check
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  // Verify webhook signature — FAIL CLOSED
  const corsHeaders = { "Content-Type": "application/json" };
  const isValid = sig ? await verifyStripeSignature(body, sig, STRIPE_WEBHOOK_SECRET) : false;
  if (!STRIPE_WEBHOOK_SECRET || !sig || !isValid) {
    console.error("Webhook signature verification failed");
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const event = JSON.parse(body);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const tenantId = session.metadata?.tenantId;
        const property = session.metadata?.property;
        const companyId = session.metadata?.companyId;
        const amount = (session.amount_total || 0) / 100; // cents → dollars

        if (!tenantId || !companyId) {
          console.warn("Missing metadata in Stripe session:", session.id);
          break;
        }

        // Find pending payment — first try exact match by Stripe session ID
        const { data: exactMatch } = await supabase.from("payments")
          .select("*")
          .eq("company_id", companyId)
          .eq("stripe_session_id", session.id)
          .maybeSingle();

        let pendingPayment = exactMatch;

        if (!pendingPayment) {
          // Fall back to tenant name match (backward compat for older records without stripe_session_id)
          const { data: pendingPayments } = await supabase
            .from("payments")
            .select("*")
            .eq("company_id", companyId)
            .eq("status", "pending_approval")
            .eq("tenant", session.metadata?.tenantName || "")
            .order("created_at", { ascending: false })
            .limit(1);

          if (pendingPayments && pendingPayments.length > 0) {
            pendingPayment = pendingPayments[0];
          }
        }

        if (pendingPayment) {
          const payment = pendingPayment;
          await supabase.from("payments").update({
            status: "paid",
            method: "stripe",
            stripe_session_id: session.id,
            paid_at: new Date().toISOString(),
          }).eq("id", payment.id);

          // Update tenant balance via RPC
          await supabase.rpc("update_tenant_balance", {
            p_tenant_name: session.metadata?.tenantName,
            p_company_id: companyId,
          });

          // Post journal entry: DR Checking, CR AR (direct insert — no RPC)
          const { data: chkAcct } = await supabase.from("acct_accounts").select("id").eq("company_id", companyId).eq("code", "1000").maybeSingle();
          const { data: arAcct } = await supabase.from("acct_accounts").select("id").eq("company_id", companyId).eq("code", "1100").maybeSingle();
          const payDate = new Date().toISOString().slice(0, 10);
          const { data: stripeJE } = await supabase.from("acct_journal_entries").insert([{
            company_id: companyId, date: payDate,
            description: `Stripe payment — ${session.metadata?.tenantName} — ${property}`,
            reference: `STRIPE-${session.id.slice(-12)}`, property: property || "", status: "posted",
          }]).select("id").maybeSingle();
          if (stripeJE?.id) {
            await supabase.from("acct_journal_lines").insert([
              { journal_entry_id: stripeJE.id, company_id: companyId, account_id: chkAcct?.id || null, account_name: "Checking Account", debit: amount, credit: 0, memo: `Stripe ${session.id.slice(-8)}` },
              { journal_entry_id: stripeJE.id, company_id: companyId, account_id: arAcct?.id || null, account_name: "Accounts Receivable", debit: 0, credit: amount, memo: session.metadata?.tenantName || "" },
            ]);
          }

          // Create ledger entry — linked to the JE we just posted so
          // the unique (journal_entry_id, tenant_id) index dedupes
          // against any future trigger-based mirror, and Phase 4's
          // view-from-GL has a join key.
          await supabase.from("ledger_entries").insert({
            company_id: companyId,
            tenant: session.metadata?.tenantName,
            property,
            date: new Date().toISOString().slice(0, 10),
            description: "Stripe payment received",
            amount: -amount,
            type: "payment",
            balance: 0,
            journal_entry_id: stripeJE?.id || null,
          });

          // Log audit
          await supabase.from("audit_trail").insert({
            company_id: companyId,
            action: "create",
            module: "payments",
            details: `Stripe checkout completed: $${amount} from ${session.metadata?.tenantName}`,
            user_email: session.customer_email || "stripe",
            user_role: "system",
          });

          console.log(`Payment ${payment.id} marked paid via Stripe session ${session.id}`);
        } else {
          // No pending payment found — create one
          await supabase.from("payments").insert({
            company_id: companyId,
            tenant: session.metadata?.tenantName || "",
            property: property || "",
            amount,
            date: new Date().toISOString().slice(0, 10),
            type: "rent",
            method: "stripe",
            status: "paid",
            stripe_session_id: session.id,
          });
          console.log(`Created new paid payment from Stripe session ${session.id}`);
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object;
        const companyId = session.metadata?.companyId;
        // Mark any pending_approval payments as failed
        if (companyId && session.metadata?.tenantName) {
          await supabase.from("payments").update({ status: "failed" })
            .eq("company_id", companyId)
            .eq("status", "pending_approval")
            .eq("tenant", session.metadata.tenantName);
        }
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Webhook error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});

// Simplified Stripe signature verification (HMAC-SHA256)
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  try {
    const parts = sigHeader.split(",").reduce((acc: Record<string, string>, part: string) => {
      const [key, value] = part.split("=");
      acc[key.trim()] = value;
      return acc;
    }, {});

    const timestamp = parts["t"];
    const signature = parts["v1"];
    if (!timestamp || !signature) return false;

    // Check timestamp is within 5 minutes
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return expected === signature;
  } catch {
    return false;
  }
}
