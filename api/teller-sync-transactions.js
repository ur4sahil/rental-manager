// Vercel API Route: Sync Teller Transactions
// Called by: manual "Sync Now", post-connection sync, daily CRON
const https = require("https");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");

// Case-insensitive email equality in a Postgres LIKE pattern — escape
// the _ and % chars so "john_doe@x.com" doesn't wildcard-match
// "johnxdoe@x.com". Kept inline because api/ routes don't share the
// src/utils/helpers bundle.
function emailFilterValue(email) {
  const s = (email || "").trim().toLowerCase();
  return s.replace(/[%_,.*()\\]/g, c => "\\" + c);
}



const TELLER_API = "https://api.teller.io";
const CRON_SECRET = process.env.CRON_SECRET || "";
const FETCH_TIMEOUT_MS = 25000;
const CRON_CONCURRENCY = 3;

// Decrypt AES-GCM — supports both the new v3 per-credential-salt scheme
// (encryption_salt populated) and the legacy Teller key scheme that
// pre-dates M15. Once a row is rewritten through /api/teller-save-enrollment
// with the new scheme, the legacy branch stops being hit.
const MASTER_KEY = process.env.ENCRYPTION_KEY || "";
function decrypt(encryptedB64, ivHex, companyId, saltHex) {
  if (!encryptedB64 || !ivHex) return "";
  try {
    let key;
    if (saltHex && saltHex.length >= 16 && MASTER_KEY) {
      key = crypto.pbkdf2Sync(MASTER_KEY, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
    } else {
      const keyStr = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
      key = Buffer.from(keyStr, "utf8");
    }
    const iv = Buffer.from(ivHex, "hex");
    const raw = Buffer.from(encryptedB64, "base64");
    // AES-GCM: last 16 bytes are the auth tag
    const authTag = raw.slice(raw.length - 16);
    const ciphertext = raw.slice(0, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, null, "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return "";
  }
}

function buildFingerprint(feedId, date, amount, description) {
  const norm = (description || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  return `${feedId}|${date}|${Math.round(amount * 100)}|${norm}`;
}

// mTLS fetch to Teller API
function tellerFetch(url, accessToken) {
  const certB64 = process.env.TELLER_CERT_B64;
  const keyB64 = process.env.TELLER_KEY_B64;
  const cert = certB64 ? Buffer.from(certB64, "base64").toString("utf8") : undefined;
  const key = keyB64 ? Buffer.from(keyB64, "base64").toString("utf8") : undefined;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(accessToken + ":").toString("base64"),
        Accept: "application/json",
      },
    };
    if (cert && key) {
      opts.cert = cert;
      opts.key = key;
    }
    const req = https.request(opts, (r) => {
      let body = "";
      r.on("data", (chunk) => (body += chunk));
      r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Teller request timeout after ${FETCH_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.method === "GET" ? {} : (req.body || {});

    // Auth: JWT, CRON_SECRET in body, or Vercel Cron (GET with Bearer CRON_SECRET)
    let companyFilter = null;
    const authHeader = req.headers.authorization;
    const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && (
      cronSecretMatches(body.cron_secret, CRON_SECRET) ||
      (req.method === "GET" && isCronSecretBearer(authHeader, CRON_SECRET))
    );

    if (isCronAuth) {
      companyFilter = null; // sync all
    } else if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Unauthorized" });

      if (!body.company_id) return res.status(400).json({ error: "company_id required" });

      const { data: mem } = await supabase
        .from("company_members")
        .select("role")
        .eq("company_id", body.company_id)
        .ilike("user_email", emailFilterValue(user.email || ""))
        .eq("status", "active")
        .maybeSingle();
      if (!mem) return res.status(403).json({ error: "Not a member of this company" });
      companyFilter = body.company_id;
    } else {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Include 'errored' so transient Teller failures (504s etc.) auto-retry on next run.
    // 'needs_reauth' is excluded — that requires the user to re-link.
    let query = supabase.from("bank_connection").select("*").in("connection_status", ["active", "errored"]).eq("source_type", "teller");
    if (companyFilter) query = query.eq("company_id", companyFilter);
    const { data: connections } = await query;

    if (!connections || connections.length === 0) {
      return res.status(200).json({ synced: 0, message: "No active Teller connections" });
    }

    async function syncOneConnection(conn) {
      // Create sync event
      const { data: syncEvent } = await supabase
        .from("plaid_sync_event")
        .insert({ company_id: conn.company_id, bank_connection_id: conn.id, status: "syncing" })
        .select("id")
        .single();

      try {
        const accessToken = decrypt(conn.access_token_encrypted, conn.encryption_iv, conn.company_id, conn.encryption_salt);
        if (!accessToken) throw new Error("Failed to decrypt access token");

        // Get feeds for this connection
        const { data: feeds } = await supabase
          .from("bank_account_feed")
          .select("id, plaid_account_id")
          .eq("bank_connection_id", conn.id)
          .eq("status", "active");

        let added = 0;

        for (const feed of feeds || []) {
          const tellerAccountId = feed.plaid_account_id;
          if (!tellerAccountId) continue;

          const txnRes = await tellerFetch(`${TELLER_API}/accounts/${tellerAccountId}/transactions`, accessToken);

          if (txnRes.status === 401 || txnRes.status === 403) {
            await supabase
              .from("bank_connection")
              .update({ connection_status: "needs_reauth", last_error_code: "AUTH_FAILED", last_error_message: "Re-authentication required" })
              .eq("id", conn.id);
            throw new Error("AUTH_FAILED");
          }

          if (!txnRes.ok) {
            // Log the raw body server-side; rethrow a generic so it
            // never reaches the browser via the response body.
            console.error("[teller-sync] Teller /transactions failed", { status: txnRes.status, body: (txnRes.body || "").slice(0, 2000) });
            throw new Error(`Teller API error (${txnRes.status})`);
          }

          let tellerTxns = JSON.parse(txnRes.body);

          // Filter by date range if provided
          if (body.from_date) tellerTxns = tellerTxns.filter((t) => t.date >= body.from_date);
          if (body.to_date) tellerTxns = tellerTxns.filter((t) => t.date <= body.to_date);

          // Get existing fingerprints for dedup
          const { data: existingFps } = await supabase
            .from("bank_feed_transaction")
            .select("fingerprint_hash")
            .eq("bank_account_feed_id", feed.id)
            .eq("company_id", conn.company_id);
          const existingSet = new Set((existingFps || []).map((f) => f.fingerprint_hash));

          const inserts = [];
          for (const txn of tellerTxns) {
            if (txn.status === "pending") continue;

            const amount = Math.abs(parseFloat(txn.amount) || 0);
            const direction = txn.type === "deposit" || txn.type === "credit" ? "inflow" : "outflow";
            const date = txn.date || "";
            const desc = txn.description || "";
            const fp = buildFingerprint(feed.id, date, direction === "outflow" ? -amount : amount, desc);

            if (existingSet.has(fp)) continue;

            // Persist a minimal whitelist of fields rather than the full
            // Teller payload. The upstream txn object can include ACH
            // processor details, counterparty routing fragments, and
            // merchant enrichment PII that we don't need to serve the
            // UI. Keeping only the fields the reconciler actually reads
            // reduces the blast radius if RLS on bank_feed_transaction
            // ever slipped.
            const sanitizedPayload = {
              id: txn.id,
              date: txn.date,
              amount: txn.amount,
              description: txn.description,
              type: txn.type,
              status: txn.status,
              running_balance: txn.running_balance,
              details: txn.details ? {
                category: txn.details.category,
                processing_status: txn.details.processing_status,
                counterparty: txn.details.counterparty ? {
                  name: txn.details.counterparty.name,
                  type: txn.details.counterparty.type,
                } : undefined,
              } : undefined,
            };
            inserts.push({
              company_id: conn.company_id,
              bank_account_feed_id: feed.id,
              source_type: "teller",
              provider_transaction_id: txn.id,
              posted_date: date,
              amount,
              direction,
              bank_description_raw: desc,
              bank_description_clean: desc,
              payee_raw: txn.details?.counterparty?.name || "",
              payee_normalized: txn.details?.counterparty?.name || "",
              check_number: null,
              reference_number: null,
              balance_after: txn.running_balance ? parseFloat(txn.running_balance) : null,
              fingerprint_hash: fp,
              status: "for_review",
              raw_payload_json: sanitizedPayload,
            });
          }

          // Insert in batches
          for (let i = 0; i < inserts.length; i += 50) {
            const chunk = inserts.slice(i, i + 50);
            const { error: insErr } = await supabase.from("bank_feed_transaction").insert(chunk);
            if (insErr) {
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
            const balRes = await tellerFetch(`${TELLER_API}/accounts/${tellerAccountId}/balances`, accessToken);
            if (balRes.ok) {
              const bal = JSON.parse(balRes.body);
              await supabase
                .from("bank_account_feed")
                .update({
                  bank_balance_current: parseFloat(bal.ledger) || null,
                  last_synced_at: new Date().toISOString(),
                  review_count_cached: inserts.length,
                })
                .eq("id", feed.id);
            }
          } catch {}
        }

        // Update connection
        await supabase
          .from("bank_connection")
          .update({ last_successful_sync_at: new Date().toISOString(), connection_status: "active", last_error_code: null, last_error_message: null })
          .eq("id", conn.id);

        // Update sync event
        await supabase
          .from("plaid_sync_event")
          .update({ completed_at: new Date().toISOString(), added_count: added, status: "success" })
          .eq("id", syncEvent?.id);

        return { added, error: null };
      } catch (e) {
        await supabase
          .from("plaid_sync_event")
          .update({ completed_at: new Date().toISOString(), status: "failed", error_json: { message: e.message } })
          .eq("id", syncEvent?.id);

        if (e.message !== "AUTH_FAILED") {
          await supabase
            .from("bank_connection")
            .update({ connection_status: "errored", last_error_message: e.message })
            .eq("id", conn.id);
        }
        return { added: 0, error: e.message };
      }
    }

    // Run connections in parallel with a concurrency cap. One slow/stuck
    // institution no longer blocks the rest of the tenants' syncs.
    const results = new Array(connections.length);
    let cursor = 0;
    async function worker() {
      while (cursor < connections.length) {
        const i = cursor++;
        results[i] = await syncOneConnection(connections[i]);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CRON_CONCURRENCY, connections.length) }, worker)
    );
    const totalAdded = results.reduce((s, r) => s + (r?.added || 0), 0);
    const totalErrors = results.filter((r) => r?.error).length;

    return res.status(200).json({ connections_processed: connections.length, total_added: totalAdded, errors: totalErrors });
  } catch (e) {
    console.error("teller-sync error:", e.message);
    return res.status(500).json({ error: "Sync failed. Please try again." });
  }
};
