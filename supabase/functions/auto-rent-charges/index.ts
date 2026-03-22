// Supabase Edge Function: Auto Rent Charges + Recurring JE Automation
// Runs daily via pg_cron or manual invoke to:
// 1. Post rent charges for active leases
// 2. Process recurring journal entries
// 3. Trigger notification queue processing
// 4. Check HOA payment due dates
// Deploy: supabase functions deploy auto-rent-charges --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Rate Limiter (per-IP, sliding window) ---
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 5;        // max requests (cron-only)
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

serve(async (req) => {
  // Rate limit check
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const results: Record<string, any> = {};

  try {
    // === 1. AUTO RENT CHARGES ===
    const { data: companies } = await supabase.from("companies").select("id");
    let totalRentCharged = 0;

    for (const company of (companies || [])) {
      const companyId = company.id;

      // Get active leases
      const { data: leases } = await supabase.from("leases").select("*")
        .eq("company_id", companyId).eq("status", "active");

      if (!leases || leases.length === 0) continue;

      // Get existing rent charges for this month to avoid duplicates
      const { data: existingJEs } = await supabase.from("acct_journal_entries").select("reference")
        .eq("company_id", companyId).like("reference", `RENT-AUTO-${currentMonth}%`);
      const existingRefs = new Set((existingJEs || []).map((j: any) => j.reference));

      for (const lease of leases) {
        const ref = `RENT-AUTO-${currentMonth}-${lease.tenant_name?.replace(/\s+/g, "-").slice(0, 20)}`;
        if (existingRefs.has(ref)) continue;

        // Check lease dates
        if (lease.start_date > today || (lease.end_date && lease.end_date < today)) continue;

        const rent = lease.rent_amount || 0;
        if (rent <= 0) continue;

        // Post journal entry: DR AR, CR Rental Income
        const jeId = `je-rent-${companyId.slice(-6)}-${Date.now().toString(36)}`;
        await supabase.rpc("create_journal_entry", {
          p_id: jeId,
          p_company_id: companyId,
          p_number: `RENT-${Date.now().toString(36).toUpperCase()}`,
          p_date: today,
          p_description: `Rent charge — ${lease.tenant_name} — ${lease.property}`,
          p_reference: ref,
          p_property: lease.property || "",
          p_status: "posted",
          p_lines: JSON.stringify([
            { account_id: `${companyId}-1100`, account_name: "Accounts Receivable", debit: rent, credit: 0, memo: lease.tenant_name },
            { account_id: `${companyId}-4000`, account_name: "Rental Income", debit: 0, credit: rent, memo: `${lease.tenant_name} — ${lease.property}` },
          ]),
        });

        // Create ledger entry
        await supabase.from("ledger_entries").insert({
          company_id: companyId, tenant: lease.tenant_name, property: lease.property,
          date: today, description: `Rent charge — ${currentMonth}`,
          amount: rent, type: "charge", balance: 0,
        });

        // Update tenant balance
        await supabase.rpc("update_tenant_balance", {
          p_tenant_name: lease.tenant_name, p_company_id: companyId,
        });

        totalRentCharged++;
      }
    }
    results.rentCharges = totalRentCharged;

    // === 2. RECURRING JOURNAL ENTRIES ===
    let recurringPosted = 0;
    const { data: recurringEntries } = await supabase.from("recurring_journal_entries").select("*")
      .eq("status", "active").lte("next_post_date", today);

    for (const entry of (recurringEntries || [])) {
      const ref = `RECUR-${entry.id?.slice(-8)}-${currentMonth}`;
      // Check duplicate
      const { data: existing } = await supabase.from("acct_journal_entries").select("id")
        .eq("company_id", entry.company_id).eq("reference", ref).limit(1);
      if (existing && existing.length > 0) continue;

      const jeId = `je-recur-${Date.now().toString(36)}`;
      await supabase.rpc("create_journal_entry", {
        p_id: jeId,
        p_company_id: entry.company_id,
        p_number: `REC-${Date.now().toString(36).toUpperCase()}`,
        p_date: today,
        p_description: entry.description || "Recurring charge",
        p_reference: ref,
        p_property: entry.property || "",
        p_status: "posted",
        p_lines: JSON.stringify([
          { account_id: entry.debit_account_id, account_name: entry.debit_account_name || "", debit: entry.amount, credit: 0, memo: entry.tenant_name || "" },
          { account_id: entry.credit_account_id, account_name: entry.credit_account_name || "", debit: 0, credit: entry.amount, memo: entry.tenant_name || "" },
        ]),
      });

      // Calculate next post date
      const nextDate = new Date(entry.next_post_date || today);
      if (entry.frequency === "monthly") nextDate.setMonth(nextDate.getMonth() + 1);
      else if (entry.frequency === "quarterly") nextDate.setMonth(nextDate.getMonth() + 3);
      else if (entry.frequency === "annually") nextDate.setFullYear(nextDate.getFullYear() + 1);
      else nextDate.setMonth(nextDate.getMonth() + 1);

      await supabase.from("recurring_journal_entries").update({
        next_post_date: nextDate.toISOString().slice(0, 10),
        last_posted_date: today,
      }).eq("id", entry.id);

      recurringPosted++;
    }
    results.recurringPosted = recurringPosted;

    // === 3. HOA PAYMENT REMINDERS ===
    let hoaReminders = 0;
    const sevenDaysOut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { data: hoaDue } = await supabase.from("hoa_payments").select("*")
      .eq("status", "unpaid").lte("due_date", sevenDaysOut).gte("due_date", today);

    for (const hoa of (hoaDue || [])) {
      // Queue notification
      await supabase.from("notification_queue").insert({
        company_id: hoa.company_id,
        type: "hoa_due",
        recipient_email: "admin", // will be resolved by the notification processor
        data: JSON.stringify({
          property: hoa.property, hoaName: hoa.hoa_name,
          amount: hoa.amount, dueDate: hoa.due_date,
        }),
        status: "pending",
      });
      hoaReminders++;
    }
    results.hoaReminders = hoaReminders;

    // === 4. TRIGGER NOTIFICATION PROCESSING ===
    try {
      const notifUrl = `${SUPABASE_URL}/functions/v1/send-notification`;
      await fetch(notifUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
      });
      results.notificationsTrigger = "sent";
    } catch (e) {
      results.notificationsTrigger = "failed: " + (e as Error).message;
    }

    // === 5. LEASE EXPIRATION WARNINGS ===
    let leaseWarnings = 0;
    const sixtyDaysOut = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const { data: expiringLeases } = await supabase.from("leases").select("*")
      .eq("status", "active").lte("end_date", sixtyDaysOut).gte("end_date", today);

    for (const lease of (expiringLeases || [])) {
      const daysLeft = Math.ceil((new Date(lease.end_date).getTime() - Date.now()) / 86400000);
      // Only warn at 60, 30, 14, 7 day marks
      if (![60, 30, 14, 7].includes(daysLeft)) continue;

      const ref = `LEASE-WARN-${lease.id?.slice(-8)}-${daysLeft}d`;
      const { data: existingNotif } = await supabase.from("notification_queue").select("id")
        .eq("company_id", lease.company_id).eq("type", "lease_expiry")
        .like("data", `%${ref}%`).limit(1);
      if (existingNotif && existingNotif.length > 0) continue;

      await supabase.from("notification_queue").insert({
        company_id: lease.company_id,
        type: "lease_expiry",
        recipient_email: "admin",
        data: JSON.stringify({
          tenant: lease.tenant_name, property: lease.property,
          date: lease.end_date, daysLeft, ref,
        }),
        status: "pending",
      });
      leaseWarnings++;
    }
    results.leaseWarnings = leaseWarnings;

    return new Response(JSON.stringify({ success: true, date: today, ...results }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
