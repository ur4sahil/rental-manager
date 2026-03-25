// Supabase Edge Function: Sync Plaid Transactions
// Deploy: supabase functions deploy plaid-sync-transactions --no-verify-jwt
// Called by: daily CRON, manual "Sync Now", or webhook
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID") || "";
const PLAID_SECRET = Deno.env.get("PLAID_SECRET") || "";
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";
const PLAID_BASE = PLAID_ENV === "production" ? "https://production.plaid.com" : PLAID_ENV === "development" ? "https://development.plaid.com" : "https://sandbox.plaid.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// Decrypt AES-GCM (matches frontend decryptCredential)
async function decrypt(encryptedB64: string, ivHex: string, companyId: string): Promise<string> {
  if (!encryptedB64 || !ivHex) return "";
  try {
    const keyStr = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyStr), { name: "AES-GCM" }, false, ["decrypt"]);
    const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    const ciphertext = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch { return ""; }
}

function buildFingerprint(feedId: string, date: string, amount: number, description: string): string {
  const norm = (description || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  return `${feedId}|${date}|${Math.round(amount * 100)}|${norm}`;
}

serve(async (req) => {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Auth: either JWT or CRON_SECRET
    let companyFilter: string | null = null;
    const authHeader = req.headers.get("Authorization");
    let body: any = {};
    try { body = await req.json(); } catch {}

    if (body.cron_secret === CRON_SECRET && CRON_SECRET) {
      // CRON call — sync all active connections
      companyFilter = null;
    } else if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
      companyFilter = body.company_id || null;
    } else {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    // Get active connections
    let query = supabase.from("bank_connection").select("*").eq("connection_status", "active");
    if (companyFilter) query = query.eq("company_id", companyFilter);
    const { data: connections } = await query;

    if (!connections || connections.length === 0) {
      return new Response(JSON.stringify({ synced: 0, message: "No active connections" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let totalAdded = 0, totalModified = 0, totalErrors = 0;

    for (const conn of connections) {
      // Create sync event
      const { data: syncEvent } = await supabase.from("plaid_sync_event").insert({
        company_id: conn.company_id, bank_connection_id: conn.id,
        sync_cursor_before: conn.plaid_sync_cursor || null, status: "syncing"
      }).select("id").single();

      try {
        // Decrypt access token
        const accessToken = await decrypt(conn.access_token_encrypted, conn.encryption_iv, conn.company_id);
        if (!accessToken) throw new Error("Failed to decrypt access token");

        // Get accounts for this connection
        const { data: feeds } = await supabase.from("bank_account_feed").select("id, plaid_account_id")
          .eq("bank_connection_id", conn.id).eq("status", "active");
        const feedMap = new Map((feeds || []).map(f => [f.plaid_account_id, f.id]));

        // Use Plaid Transactions Sync API (cursor-based)
        let cursor = conn.plaid_sync_cursor || "";
        let hasMore = true;
        let added = 0, modified = 0, removed = 0;

        while (hasMore) {
          const syncRes = await fetch(`${PLAID_BASE}/transactions/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET,
              access_token: accessToken, cursor: cursor || undefined,
              count: 100
            }),
          });
          const syncData = await syncRes.json();

          if (syncData.error_code) {
            if (syncData.error_code === "ITEM_LOGIN_REQUIRED") {
              await supabase.from("bank_connection").update({ connection_status: "needs_reauth", last_error_code: syncData.error_code, last_error_message: syncData.error_message }).eq("id", conn.id);
              throw new Error("ITEM_LOGIN_REQUIRED");
            }
            throw new Error(syncData.error_message || syncData.error_code);
          }

          // Process added transactions
          for (const txn of syncData.added || []) {
            const feedId = feedMap.get(txn.account_id);
            if (!feedId) continue;
            const amount = Math.abs(txn.amount);
            const direction = txn.amount < 0 ? "inflow" : "outflow"; // Plaid: negative = money in
            const date = txn.date || txn.authorized_date || "";
            const fp = buildFingerprint(feedId, date, txn.amount, txn.name || "");

            const { error: insErr } = await supabase.from("bank_feed_transaction").insert({
              company_id: conn.company_id, bank_account_feed_id: feedId,
              source_type: "plaid", provider_transaction_id: txn.transaction_id,
              posted_date: date, amount, direction,
              bank_description_raw: txn.original_description || txn.name || "",
              bank_description_clean: txn.name || txn.merchant_name || "",
              payee_raw: txn.merchant_name || txn.name || "",
              payee_normalized: txn.merchant_name || "",
              check_number: txn.check_number || null,
              fingerprint_hash: fp, status: "for_review",
              raw_payload_json: txn
            });
            if (!insErr) added++;
          }

          // Process modified transactions (update existing)
          for (const txn of syncData.modified || []) {
            await supabase.from("bank_feed_transaction").update({
              bank_description_clean: txn.name || txn.merchant_name || "",
              payee_normalized: txn.merchant_name || "",
              amount: Math.abs(txn.amount),
              posted_date: txn.date || txn.authorized_date,
              raw_payload_json: txn
            }).eq("provider_transaction_id", txn.transaction_id).eq("company_id", conn.company_id);
            modified++;
          }

          // Process removed transactions
          for (const txn of syncData.removed || []) {
            await supabase.from("bank_feed_transaction").update({
              status: "excluded", exclusion_reason: "removed_by_bank"
            }).eq("provider_transaction_id", txn.transaction_id).eq("company_id", conn.company_id);
            removed++;
          }

          cursor = syncData.next_cursor;
          hasMore = syncData.has_more;
        }

        // Update connection with new cursor
        await supabase.from("bank_connection").update({
          plaid_sync_cursor: cursor,
          last_successful_sync_at: new Date().toISOString(),
          connection_status: "active",
          last_error_code: null, last_error_message: null
        }).eq("id", conn.id);

        // Update sync event
        await supabase.from("plaid_sync_event").update({
          completed_at: new Date().toISOString(),
          sync_cursor_after: cursor,
          added_count: added, modified_count: modified, removed_count: removed,
          status: "success"
        }).eq("id", syncEvent?.id);

        // Update feed balance caches
        for (const feed of (feeds || [])) {
          const reviewCount = (await supabase.from("bank_feed_transaction").select("id", { count: "exact" })
            .eq("bank_account_feed_id", feed.id).eq("status", "for_review")).count || 0;
          await supabase.from("bank_account_feed").update({
            review_count_cached: reviewCount, last_synced_at: new Date().toISOString()
          }).eq("id", feed.id);
        }

        totalAdded += added;
        totalModified += modified;

      } catch (e) {
        totalErrors++;
        await supabase.from("plaid_sync_event").update({
          completed_at: new Date().toISOString(), status: "failed",
          error_json: { message: e.message }
        }).eq("id", syncEvent?.id);

        if (e.message !== "ITEM_LOGIN_REQUIRED") {
          await supabase.from("bank_connection").update({
            connection_status: "errored",
            last_error_message: e.message
          }).eq("id", conn.id);
        }
      }
    }

    return new Response(JSON.stringify({
      connections_processed: connections.length,
      total_added: totalAdded, total_modified: totalModified, errors: totalErrors
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
