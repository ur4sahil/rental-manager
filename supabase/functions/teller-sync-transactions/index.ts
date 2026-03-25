// Supabase Edge Function: Sync Teller Transactions
// Deploy: supabase functions deploy teller-sync-transactions --no-verify-jwt
// Called by: daily CRON, manual "Sync Now"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELLER_API = "https://api.teller.io";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// mTLS: In production, Teller requires a client certificate.
// Store cert and key as base64 environment variables:
//   TELLER_CERT_B64 = base64 of teller-cert.pem
//   TELLER_KEY_B64  = base64 of teller-private-key.pem
// Deno's native fetch supports TLS client certificates via Deno.createHttpClient
function createTellerClient(): Deno.HttpClient | undefined {
  const certB64 = Deno.env.get("TELLER_CERT_B64");
  const keyB64 = Deno.env.get("TELLER_KEY_B64");
  if (certB64 && keyB64) {
    try {
      const cert = atob(certB64);
      const key = atob(keyB64);
      return Deno.createHttpClient({ certChain: cert, privateKey: key });
    } catch (e) {
      console.warn("Failed to create mTLS client:", e.message);
    }
  }
  return undefined; // sandbox/development — no cert needed
}

// Decrypt AES-GCM
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

async function tellerFetch(url: string, accessToken: string, client?: Deno.HttpClient): Promise<Response> {
  const opts: RequestInit & { client?: Deno.HttpClient } = {
    headers: {
      "Authorization": "Basic " + btoa(accessToken + ":"),
      "Accept": "application/json",
    },
  };
  if (client) (opts as any).client = client;
  return fetch(url, opts);
}

serve(async (req) => {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tlsClient = createTellerClient();

    // Auth: JWT or CRON_SECRET
    let companyFilter: string | null = null;
    const authHeader = req.headers.get("Authorization");
    let body: any = {};
    try { body = await req.json(); } catch {}

    if (CRON_SECRET && body.cron_secret === CRON_SECRET) {
      companyFilter = null; // sync all
    } else if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
      companyFilter = body.company_id || null;
    } else {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    // Get active Teller connections
    let query = supabase.from("bank_connection").select("*").eq("connection_status", "active").eq("source_type", "teller");
    if (companyFilter) query = query.eq("company_id", companyFilter);
    const { data: connections } = await query;

    if (!connections || connections.length === 0) {
      return new Response(JSON.stringify({ synced: 0, message: "No active Teller connections" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let totalAdded = 0, totalErrors = 0;

    for (const conn of connections) {
      // Create sync event
      const { data: syncEvent } = await supabase.from("plaid_sync_event").insert({
        company_id: conn.company_id, bank_connection_id: conn.id,
        status: "syncing"
      }).select("id").single();

      try {
        // Decrypt access token
        const accessToken = await decrypt(conn.access_token_encrypted, conn.encryption_iv, conn.company_id);
        if (!accessToken) throw new Error("Failed to decrypt access token");

        // Get feeds for this connection
        const { data: feeds } = await supabase.from("bank_account_feed").select("id, plaid_account_id")
          .eq("bank_connection_id", conn.id).eq("status", "active");

        let added = 0;

        for (const feed of (feeds || [])) {
          const tellerAccountId = feed.plaid_account_id; // reused column
          if (!tellerAccountId) continue;

          // Fetch transactions from Teller
          const txnRes = await tellerFetch(`${TELLER_API}/accounts/${tellerAccountId}/transactions`, accessToken, tlsClient);

          if (txnRes.status === 401 || txnRes.status === 403) {
            await supabase.from("bank_connection").update({
              connection_status: "needs_reauth", last_error_code: "AUTH_FAILED",
              last_error_message: "Re-authentication required"
            }).eq("id", conn.id);
            throw new Error("AUTH_FAILED");
          }

          if (!txnRes.ok) {
            const errText = await txnRes.text();
            throw new Error(`Teller API error (${txnRes.status}): ${errText}`);
          }

          const tellerTxns = await txnRes.json();

          // Get existing fingerprints for dedup
          const { data: existingFps } = await supabase.from("bank_feed_transaction")
            .select("fingerprint_hash").eq("bank_account_feed_id", feed.id).eq("company_id", conn.company_id);
          const existingSet = new Set((existingFps || []).map(f => f.fingerprint_hash));

          const inserts = [];
          for (const txn of tellerTxns) {
            if (txn.status === "pending") continue; // skip pending transactions

            const amount = Math.abs(parseFloat(txn.amount) || 0);
            // Teller: "deposit" = money in, anything else = money out
            const direction = txn.type === "deposit" || txn.type === "credit" ? "inflow" : "outflow";
            const date = txn.date || "";
            const desc = txn.description || "";
            const fp = buildFingerprint(feed.id, date, direction === "outflow" ? -amount : amount, desc);

            if (existingSet.has(fp)) continue; // duplicate

            inserts.push({
              company_id: conn.company_id,
              bank_account_feed_id: feed.id,
              source_type: "teller",
              provider_transaction_id: txn.id,
              posted_date: date,
              amount: amount,
              direction: direction,
              bank_description_raw: desc,
              bank_description_clean: desc,
              payee_raw: txn.details?.counterparty?.name || "",
              payee_normalized: txn.details?.counterparty?.name || "",
              check_number: null,
              reference_number: null,
              balance_after: txn.running_balance ? parseFloat(txn.running_balance) : null,
              fingerprint_hash: fp,
              status: "for_review",
              raw_payload_json: txn,
            });
          }

          // Insert in batches
          for (let i = 0; i < inserts.length; i += 50) {
            const chunk = inserts.slice(i, i + 50);
            const { error: insErr } = await supabase.from("bank_feed_transaction").insert(chunk);
            if (insErr) {
              // Insert individually to skip duplicates
              for (const item of chunk) {
                const { error } = await supabase.from("bank_feed_transaction").insert([item]);
                if (!error) added++;
              }
            } else {
              added += chunk.length;
            }
          }

          // Update feed balance + sync time
          try {
            const balRes = await tellerFetch(`${TELLER_API}/accounts/${tellerAccountId}/balances`, accessToken, tlsClient);
            if (balRes.ok) {
              const bal = await balRes.json();
              await supabase.from("bank_account_feed").update({
                bank_balance_current: parseFloat(bal.ledger) || null,
                last_synced_at: new Date().toISOString(),
                review_count_cached: inserts.length
              }).eq("id", feed.id);
            }
          } catch {}
        }

        // Update connection
        await supabase.from("bank_connection").update({
          last_successful_sync_at: new Date().toISOString(),
          connection_status: "active", last_error_code: null, last_error_message: null
        }).eq("id", conn.id);

        // Update sync event
        await supabase.from("plaid_sync_event").update({
          completed_at: new Date().toISOString(), added_count: added,
          status: "success"
        }).eq("id", syncEvent?.id);

        totalAdded += added;

      } catch (e) {
        totalErrors++;
        await supabase.from("plaid_sync_event").update({
          completed_at: new Date().toISOString(), status: "failed",
          error_json: { message: e.message }
        }).eq("id", syncEvent?.id);

        if (e.message !== "AUTH_FAILED") {
          await supabase.from("bank_connection").update({
            connection_status: "errored", last_error_message: e.message
          }).eq("id", conn.id);
        }
      }
    }

    return new Response(JSON.stringify({
      connections_processed: connections.length,
      total_added: totalAdded, errors: totalErrors
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
