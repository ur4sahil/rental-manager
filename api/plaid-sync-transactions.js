// Vercel API Route: Sync Plaid transactions.
// Called by: manual "Sync Now", post-connection sync, daily CRON, and the
// Plaid webhook (SYNC_UPDATES_AVAILABLE). Uses /transactions/sync — Plaid's
// cursor-based incremental endpoint. The cursor per Item lives in
// bank_connection.plaid_sync_cursor; each call returns only what changed since
// then (added / modified / removed), so steady-state syncs are tiny.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");
const { getPlaidClient, decrypt, plaidTxnToRow, buildFingerprint } = require("./_plaid");

const CRON_SECRET = process.env.CRON_SECRET || "";
const CRON_CONCURRENCY = 3;
const MAX_SYNC_PAGES = 50; // safety cap; each page is up to 500 changes

function emailFilterValue(email) {
  const s = (email || "").trim().toLowerCase();
  return s.replace(/[%_,.*()\\]/g, c => "\\" + c);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.method === "GET" ? {} : (req.body || {});

    // Auth: JWT (scoped to company), CRON_SECRET in body, or Vercel Cron
    // (GET with Bearer CRON_SECRET). Same model as the retired teller-sync.
    let companyFilter = null;
    let itemFilter = null; // webhook can target a single item_id
    const authHeader = req.headers.authorization;
    const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && (
      cronSecretMatches(body.cron_secret, CRON_SECRET) ||
      (req.method === "GET" && isCronSecretBearer(authHeader, CRON_SECRET))
    );

    if (isCronAuth) {
      companyFilter = null; // sync all
      if (body.item_id) itemFilter = body.item_id; // webhook-triggered single item
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

    let query = supabase.from("bank_connection").select("*").in("connection_status", ["active", "errored"]).eq("source_type", "plaid");
    if (companyFilter) query = query.eq("company_id", companyFilter);
    if (itemFilter) query = query.eq("plaid_item_id", itemFilter);
    const { data: connections } = await query;

    if (!connections || connections.length === 0) {
      return res.status(200).json({ synced: 0, message: "No active Plaid connections" });
    }

    const plaid = getPlaidClient();

    async function syncOneConnection(conn) {
      const { data: syncEvent } = await supabase
        .from("plaid_sync_event")
        .insert({ company_id: conn.company_id, bank_connection_id: conn.id, status: "syncing" })
        .select("id")
        .single();

      try {
        const accessToken = decrypt(conn.access_token_encrypted, conn.encryption_iv, conn.encryption_salt);
        if (!accessToken) throw new Error("Failed to decrypt access token");

        const { data: feeds } = await supabase
          .from("bank_account_feed")
          .select("id, plaid_account_id, status")
          .eq("bank_connection_id", conn.id);
        const feedByAcct = new Map((feeds || []).filter(f => f.plaid_account_id).map(f => [f.plaid_account_id, f]));

        // ── Pull all changes since our stored cursor ──────────────────────
        let cursor = conn.plaid_sync_cursor || null;
        const added = [], modified = [], removed = [];
        let pages = 0;
        while (pages < MAX_SYNC_PAGES) {
          pages++;
          let resp;
          try {
            resp = await plaid.transactionsSync({
              access_token: accessToken,
              cursor: cursor || undefined,
              count: 500,
            });
          } catch (e) {
            const code = e.response?.data?.error_code;
            if (code === "PRODUCT_NOT_READY") { await sleep(2500); pages--; continue; }
            if (code === "ITEM_LOGIN_REQUIRED") {
              await supabase.from("bank_connection")
                .update({ connection_status: "needs_reauth", last_error_code: "ITEM_LOGIN_REQUIRED", last_error_message: "Re-authentication required" })
                .eq("id", conn.id);
              throw new Error("ITEM_LOGIN_REQUIRED");
            }
            throw e;
          }
          added.push(...resp.data.added);
          modified.push(...resp.data.modified);
          removed.push(...resp.data.removed);
          cursor = resp.data.next_cursor;
          if (!resp.data.has_more) break;
          await sleep(120);
        }

        // ── Removals: drop only untouched (for_review) rows; never delete a
        // transaction the user already categorized/posted to the GL. ────────
        let removedCount = 0;
        const removedIds = removed.map(r => r.transaction_id).filter(Boolean);
        for (let i = 0; i < removedIds.length; i += 100) {
          const chunk = removedIds.slice(i, i + 100);
          const { data: del } = await supabase
            .from("bank_feed_transaction")
            .delete()
            .eq("company_id", conn.company_id)
            .eq("status", "for_review")
            .in("provider_transaction_id", chunk)
            .select("id");
          removedCount += del?.length || 0;
        }

        // ── Additions + modifications: skip pending, map to rows, dedup ────
        // from_date (set by the post-connect "Import" using the user's chosen
        // start date) caps how far back the INITIAL import reaches. Plaid's
        // /transactions/sync has no date param — it returns the whole
        // days_requested window — so we filter on insert. The cursor still
        // advances past the older rows, so they're skipped for good (not
        // re-pulled later). The daily cron/webhook pass no from_date, so
        // steady-state syncs import everything new.
        const fromDate = body.from_date || null;
        const candidates = [...added, ...modified].filter(t => !t.pending && (!fromDate || (t.date && t.date >= fromDate)));
        const rows = [];
        for (const txn of candidates) {
          const feed = feedByAcct.get(txn.account_id);
          if (!feed) continue; // account not imported as a feed
          const row = plaidTxnToRow(txn, feed, conn.company_id);
          if (row) rows.push(row);
        }

        // Dedup against what's already stored:
        //   - provider_transaction_id (exact, stable) — skip re-inserts
        //   - CSV fingerprints (rows with no provider id) — cross-source crosswalk
        let addedCount = 0;
        if (rows.length) {
          const ptids = [...new Set(rows.map(r => r.provider_transaction_id).filter(Boolean))];
          const existingPtid = new Set();
          for (let i = 0; i < ptids.length; i += 100) {
            const chunk = ptids.slice(i, i + 100);
            const { data: ex } = await supabase
              .from("bank_feed_transaction")
              .select("provider_transaction_id")
              .eq("company_id", conn.company_id)
              .in("provider_transaction_id", chunk);
            (ex || []).forEach(r => r.provider_transaction_id && existingPtid.add(r.provider_transaction_id));
          }

          // CSV-only fingerprints in the batch's date window, per feed.
          const feedIds = [...new Set(rows.map(r => r.bank_account_feed_id))];
          const dates = rows.map(r => r.posted_date).filter(Boolean).sort();
          const minDate = dates[0], maxDate = dates[dates.length - 1];
          const existingFpCsv = new Set();
          for (const fid of feedIds) {
            let q = supabase
              .from("bank_feed_transaction")
              .select("fingerprint_hash, provider_transaction_id, posted_date")
              .eq("bank_account_feed_id", fid)
              .eq("company_id", conn.company_id)
              .is("provider_transaction_id", null);
            if (minDate) q = q.gte("posted_date", minDate);
            if (maxDate) q = q.lte("posted_date", maxDate);
            const { data: csvRows } = await q;
            (csvRows || []).forEach(r => r.fingerprint_hash && existingFpCsv.add(r.fingerprint_hash));
          }

          const inserts = rows.filter(r =>
            !(r.provider_transaction_id && existingPtid.has(r.provider_transaction_id)) &&
            !existingFpCsv.has(r.fingerprint_hash)
          );

          for (let i = 0; i < inserts.length; i += 50) {
            const chunk = inserts.slice(i, i + 50);
            const { error: insErr } = await supabase.from("bank_feed_transaction").insert(chunk);
            if (insErr) {
              for (const item of chunk) {
                const { error } = await supabase.from("bank_feed_transaction").insert([item]);
                if (!error) addedCount++;
              }
            } else {
              addedCount += chunk.length;
            }
          }
        }

        // Persist the new cursor + refresh balances/last_synced_at
        await supabase.from("bank_connection").update({
          plaid_sync_cursor: cursor,
          last_successful_sync_at: new Date().toISOString(),
          connection_status: "active",
          last_error_code: null,
          last_error_message: null,
        }).eq("id", conn.id);

        try {
          const balRes = await plaid.accountsBalanceGet({ access_token: accessToken });
          for (const acct of balRes.data.accounts || []) {
            const feed = feedByAcct.get(acct.account_id);
            if (!feed) continue;
            await supabase.from("bank_account_feed").update({
              bank_balance_current: acct.balances?.current != null ? parseFloat(acct.balances.current) : null,
              last_synced_at: new Date().toISOString(),
            }).eq("id", feed.id);
          }
        } catch {}

        await supabase.from("plaid_sync_event")
          .update({ completed_at: new Date().toISOString(), added_count: addedCount, status: "success" })
          .eq("id", syncEvent?.id);

        return { added: addedCount, removed: removedCount, error: null };
      } catch (e) {
        await supabase.from("plaid_sync_event")
          .update({ completed_at: new Date().toISOString(), status: "failed", error_json: { message: e.message } })
          .eq("id", syncEvent?.id);
        if (e.message !== "ITEM_LOGIN_REQUIRED") {
          await supabase.from("bank_connection")
            .update({ connection_status: "errored", last_error_message: e.message })
            .eq("id", conn.id);
        }
        return { added: 0, removed: 0, error: e.message };
      }
    }

    // Bounded concurrency across connections
    const results = new Array(connections.length);
    let cursor = 0;
    async function worker() {
      while (cursor < connections.length) {
        const i = cursor++;
        results[i] = await syncOneConnection(connections[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CRON_CONCURRENCY, connections.length) }, worker));

    return res.status(200).json({
      connections_processed: connections.length,
      total_added: results.reduce((s, r) => s + (r?.added || 0), 0),
      total_removed: results.reduce((s, r) => s + (r?.removed || 0), 0),
      errors: results.filter(r => r?.error).length,
    });
  } catch (e) {
    console.error("plaid-sync error:", e.message);
    return res.status(500).json({ error: "Sync failed. Please try again." });
  }
};
