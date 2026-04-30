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
// Each paginated Teller call runs under this cap. BofA / some CU feeds
// can take a solid 20-30s on a first fetch; 25s was cutting it close
// and 0822 regularly timed out. Vercel function ceiling is 60s per
// invocation, so there's room. Pagination (below) keeps any single
// request bounded to ~500 txns so this timeout rarely matters.
const FETCH_TIMEOUT_MS = 45000;
const CRON_CONCURRENCY = 3;
// Teller caps per-page, but 500 is a reasonable page size — small
// enough that a single call is fast, large enough that 1 year of
// history is only a few round-trips.
const TELLER_PAGE_SIZE = 500;
// Safety cap. At 500/page this covers 10,000 transactions. Beyond that
// something is almost certainly wrong (loop, bad bank response, etc.)
// and we'd rather fail than hold a Vercel function hostage.
const MAX_TELLER_PAGES = 20;

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

// Fingerprint built from fields that stay stable across import sources
// (Teller API vs bank CSV). Uses:
//   - |direction| instead of signed amount so one-side sign bugs can't
//     split a txn into two rows
//   - |abs cents| for amount
//   - normalized description: lowercased, mask-token runs collapsed
//     (BofA CSV shows "ID:XXXXX29876", Teller returns "ID:8800429876"),
//     quotes stripped (CSV drops enclosing quotes, Teller keeps them),
//     whitespace collapsed
// Kept in sync with csvBuildFingerprint in src/components/Banking.js —
// any change here must mirror there or dedup breaks again.
// Conservative normalization — strip quote-style chars (CSV drops
// enclosing quotes, Teller keeps them) and collapse whitespace.
// Intentionally does NOT collapse digit runs: Confirmation #s and
// ACH IDs are what distinguish otherwise-identical transactions,
// and collapsing them creates false-positive dedup matches across
// different real-world transfers.
function normDescription(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\\"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function buildFingerprint(feedId, date, direction, absAmount, description) {
  return `${feedId}|${date}|${direction}|${Math.round(absAmount * 100)}|${normDescription(description)}`;
}

// mTLS fetch to Teller API — raw, no retry. Returns headers too so the
// retry wrapper can honor Retry-After on 429.
function tellerFetchRaw(url, accessToken) {
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
      r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body, headers: r.headers || {} }));
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Teller request timeout after ${FETCH_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parse Retry-After header. Teller may return seconds (e.g. "2") or an
// HTTP date. Clamp to a sane range so a misbehaving header can't make
// us hang for the full Vercel function budget.
function parseRetryAfter(value) {
  if (!value) return null;
  const asNum = Number(value);
  if (Number.isFinite(asNum)) return Math.min(10000, Math.max(500, asNum * 1000));
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.min(10000, Math.max(500, asDate - Date.now()));
  return null;
}

// Retry wrapper — pause on 429 (rate limit) and 503 (service unavailable),
// both of which are transient. 3 attempts with exponential backoff,
// capped at 10s per wait. Other non-2xx statuses pass through to the
// caller to handle (401/403 → reauth, 5xx → hard fail, etc).
async function tellerFetch(url, accessToken) {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 1000;
  let lastRes = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await tellerFetchRaw(url, accessToken);
    lastRes = res;
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt === MAX_ATTEMPTS - 1) return res; // give up, let caller see 429
    const retryAfter = parseRetryAfter(res.headers["retry-after"]);
    const wait = retryAfter != null ? retryAfter : Math.min(10000, BASE_DELAY_MS * Math.pow(2, attempt));
    console.warn(`[teller-sync] ${res.status} from Teller, waiting ${wait}ms before retry ${attempt + 1}/${MAX_ATTEMPTS - 1}`);
    await sleep(wait);
  }
  return lastRes;
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
        // Per-feed diagnostics so the browser can tell whether a short
        // pull was our fault (stopped paginating early) or the bank's
        // (Teller/BofA retention limit). Only included on manual /
        // JWT-authenticated syncs — cron runs don't need the noise.
        const feedStats = [];

        for (const feed of feeds || []) {
          const tellerAccountId = feed.plaid_account_id;
          if (!tellerAccountId) continue;

          // Paginate Teller. The unpaginated endpoint only returns its
          // default window (~90 days on most banks) — to pull deeper
          // history we chain with ?from_id=<oldest id of prior page>.
          // Teller returns txns newest-first, so when a page's oldest
          // date drops below body.from_date we can stop early.
          let tellerTxns = [];
          let fromId = "";
          let pagesFetched = 0;
          while (pagesFetched < MAX_TELLER_PAGES) {
            const qs = `?count=${TELLER_PAGE_SIZE}` + (fromId ? `&from_id=${encodeURIComponent(fromId)}` : "");
            const txnRes = await tellerFetch(`${TELLER_API}/accounts/${tellerAccountId}/transactions${qs}`, accessToken);

            if (txnRes.status === 401 || txnRes.status === 403) {
              await supabase
                .from("bank_connection")
                .update({ connection_status: "needs_reauth", last_error_code: "AUTH_FAILED", last_error_message: "Re-authentication required" })
                .eq("id", conn.id);
              throw new Error("AUTH_FAILED");
            }

            if (!txnRes.ok) {
              console.error("[teller-sync] Teller /transactions failed", { status: txnRes.status, body: (txnRes.body || "").slice(0, 2000) });
              throw new Error(`Teller API error (${txnRes.status})`);
            }

            const page = JSON.parse(txnRes.body);
            if (!Array.isArray(page) || page.length === 0) break;

            tellerTxns.push(...page);
            pagesFetched++;

            // Early stop: if the oldest txn on this page is already
            // before the requested from_date, no need to page further.
            const oldestOnPage = page.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), "");
            if (body.from_date && oldestOnPage && oldestOnPage < body.from_date) break;

            // Teller pagination: next page is everything older than
            // the oldest id on this page.
            const oldestId = page[page.length - 1]?.id;
            if (!oldestId || oldestId === fromId) break; // nothing new
            fromId = oldestId;
            // Tiny breather between pages. Teller's rate limits bite
            // fast when pulling a year of history across multiple
            // feeds in one connection — 150ms is unnoticeable to the
            // user but cuts our 429 rate dramatically.
            await sleep(150);
          }

          // Record what we actually pulled before client-side filtering,
          // so the caller can tell whether an empty result means "we
          // didn't paginate" or "Teller/the bank ran out of history".
          const rawOldest = tellerTxns.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), "");
          const rawNewest = tellerTxns.reduce((m, t) => (t.date && (!m || t.date > m) ? t.date : m), "");
          const feedStat = {
            feed_id: feed.id,
            pages_fetched: pagesFetched,
            raw_count: tellerTxns.length,
            raw_oldest: rawOldest || null,
            raw_newest: rawNewest || null,
          };

          // Filter by date range if provided
          if (body.from_date) tellerTxns = tellerTxns.filter((t) => t.date >= body.from_date);
          if (body.to_date) tellerTxns = tellerTxns.filter((t) => t.date <= body.to_date);
          feedStat.after_filter_count = tellerTxns.length;
          feedStats.push(feedStat);

          // Dedup: scope the fingerprint fetch by the date window of the
          // txns we're about to compare against. Previously this pulled
          // every fingerprint for the feed regardless of age — fine at
          // 500 txns per feed, painful at 10k+ where years of history
          // stack up. Teller typically returns ~90 days; limit the
          // lookup to the span of dates we actually see in this batch
          // plus a small buffer.
          const batchDates = tellerTxns.map(t => t.date).filter(Boolean).sort();
          const minDate = batchDates[0] || "";
          const maxDate = batchDates[batchDates.length - 1] || "";
          // Dedup by BOTH Teller's provider_transaction_id AND our
          // fingerprint_hash. provider_transaction_id is the primary
          // key for Teller — it's stable across syncs and unique per
          // bank txn. fingerprint_hash is the cross-source key (CSV <>
          // Teller) and the fallback for anything without a provider
          // id. Without the provider-id check, a change to the
          // fingerprint algorithm would cause the same Teller txn to
          // re-insert on the next sync — exactly what happened after
          // commit 605ddb2 removed the \d{5,}→# rule: every txn showed
          // up twice.
          // Paginate the dedup pull. Supabase's default limit is 1000
          // rows; once a feed accumulated >1000 transactions in the
          // dedup window (~90 days), older rows fell off the result
          // set and any Teller txn matching one of those older rows
          // would re-insert as a duplicate. Sigma 6027 hit this on
          // 2026-04-25/27 — 141 dupes generated in two re-syncs.
          // Pull in 1000-row pages until empty so existingPtid +
          // existingFp cover every row in the window.
          const existingFp = new Set();
          const existingPtid = new Set();
          let dedupFrom = 0;
          while (true) {
            let fpQuery = supabase
              .from("bank_feed_transaction")
              .select("fingerprint_hash, provider_transaction_id")
              .eq("bank_account_feed_id", feed.id)
              .eq("company_id", conn.company_id);
            if (minDate) fpQuery = fpQuery.gte("posted_date", minDate);
            if (maxDate) fpQuery = fpQuery.lte("posted_date", maxDate);
            const { data: page } = await fpQuery.range(dedupFrom, dedupFrom + 999);
            if (!page?.length) break;
            for (const r of page) {
              if (r.fingerprint_hash) existingFp.add(r.fingerprint_hash);
              if (r.provider_transaction_id) existingPtid.add(r.provider_transaction_id);
            }
            if (page.length < 1000) break;
            dedupFrom += 1000;
          }

          const inserts = [];
          for (const txn of tellerTxns) {
            if (txn.status === "pending") continue;

            // Direction from SIGN of amount, not from txn.type. Teller
            // reports Zelle-in and Zelle-out both as type="transfer"
            // and encodes direction by sign — ignoring the sign and
            // defaulting "transfer" to outflow flipped every Zelle
            // receipt to a negative amount. Deposits/credits already
            // arrive with positive amounts, so sign covers them too.
            const amountNum = parseFloat(txn.amount) || 0;
            const direction = amountNum >= 0 ? "inflow" : "outflow";
            const amount = Math.abs(amountNum);
            const date = txn.date || "";
            const desc = txn.description || "";
            const fp = buildFingerprint(feed.id, date, direction, amount, desc);

            // Primary: provider_transaction_id match (cheap, stable).
            // Fallback: fingerprint match (CSV-Teller crosswalk).
            if (txn.id && existingPtid.has(txn.id)) continue;
            if (existingFp.has(fp)) continue;

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

        return { added, error: null, feedStats };
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
        return { added: 0, error: e.message, feedStats: [] };
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
    const allFeedStats = results.flatMap((r) => r?.feedStats || []);

    return res.status(200).json({
      connections_processed: connections.length,
      total_added: totalAdded,
      errors: totalErrors,
      feed_stats: allFeedStats,
    });
  } catch (e) {
    console.error("teller-sync error:", e.message);
    return res.status(500).json({ error: "Sync failed. Please try again." });
  }
};
