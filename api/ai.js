// AI actions. One dispatcher, like api/daily-reminders.js.
//
// Browser-facing (company-scoped, normal auth):
//   POST /api/ai?action=ingest    { companyId, sourceTable, sourceId, sourceName, text }
//   POST /api/ai?action=extract-license
//                                 { companyId, sourceTable, sourceId, sourceName, text }
//   POST /api/ai?action=search    { companyId, query, limit, sourceId }
//   POST /api/ai?action=enqueue   { companyId, kind, subjectTable, subjectId, input, priority }
//   POST /api/ai?action=job-status{ companyId, jobId }
//   POST /api/ai?action=jobs      { companyId, status, limit }
//   POST /api/ai?action=ask       { companyId, question, sourceId, limit }  (synchronous)
//
// Worker-facing (x-worker-token, NOT company-scoped):
//   POST /api/ai?action=claim     { worker, kinds }
//   POST /api/ai?action=complete  { worker, jobId, output, model, durationMs, confidence, error }
//
// Nothing here writes to a business table. A finished job lands as
// status 'proposed'; applying it is a separate, human action. A
// confidently wrong licence number on a property you are renting out is
// a filing problem, not a UI bug.
//
// WHY A QUEUE AT ALL: a 12-page lease is 121 seconds of prefill on the
// box, and Cloudflare kills an origin request at ~100s. Long work cannot
// be a request someone waits on, so it becomes a row a worker claims --
// the same submit-and-poll shape OpenAI Batch and Vertex LRO use.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");
const { aiConfigured, askJson } = require("./_ai");
const { ingestChunks } = require("./_ai-chunk");
const { embed, toVectorLiteral } = require("./_ai-embed");
const { extractLicense } = require("./_ai-extract");

// Actions the WORKER calls. These carry no companyId -- the worker serves
// every company -- and are authenticated by a shared secret instead.
const WORKER_ACTIONS = new Set(["claim", "complete", "record-reading", "sweep-targets", "attach-bill-document", "record-utility-payment", "portal-credentials"]);
// Actions a SCHEDULER calls. A cron is nobody's session and has no current
// company -- the sweep's whole job is to walk every company that has pending
// work -- so requiring a companyId of it is requiring something that cannot
// exist. It authenticates on CRON_SECRET inside the action instead, which is
// why exempting it here removes no check.
//
// Without this the nightly sweep answered 400 "companyId is required" before
// a line of it ran, every night since it shipped, and queued nothing ever.
// The failure was invisible because a cron has nobody to tell.
const CRON_ACTIONS = new Set(["sweep"]);

function admin() {
  // BOTH names, because the two environments are not configured alike:
  // production sets only REACT_APP_SUPABASE_URL (as 19 other routes here
  // read), staging sets both. Reading only SUPABASE_URL made every route
  // in this file return 500 in production while working perfectly on
  // staging -- a difference no test catches, because the tests run
  // against staging's environment.
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Constant-time compare. A length-dependent early return leaks the token
// one character at a time to anyone willing to measure response times.
// File a utility statement or receipt in the documents table.
//
// Uploading to the bucket is not filing. Until a documents row exists the
// file is invisible to the Documents module and to the property it belongs
// to -- which is exactly how the bill statements came to look as though they
// were never stored. property_id is resolved from the address so the
// document hangs off the property, not just a matching string.
//
// Never throws. The file is already saved by the time this runs, and losing
// the upload over its index row would be the worse outcome; the caller
// reports the error instead.
async function fileUtilityDocument(sb, { companyId, property, path, safeName, type, label }) {
  try {
    // A document row with no path is worse than no row: it appears in the
    // property's folder and does nothing when clicked. Refuse to file one.
    //
    // This is not hypothetical. The backfill that filed the existing
    // statements used `WHERE pdf_storage_path IS NOT NULL`, which accepts the
    // EMPTY STRING -- and 64 of 86 production bills hold '' rather than null.
    // So 64 dead entries were filed before an E2E assertion on the signing
    // request caught it.
    if (!path || !String(path).trim()) {
      return { id: null, error: "refused to file a document with no storage path" };
    }
    let propertyId = null;
    if (property) {
      const { data: prop } = await sb.from("properties")
        .select("id").eq("company_id", companyId).eq("address", property).maybeSingle();
      propertyId = prop?.id ?? null;
    }
    const { data, error } = await sb.from("documents").insert([{
      company_id: companyId,
      name: label || safeName,
      // BOTH hold the storage path, matching DocUploadModal. getSignedUrl is
      // called as getSignedUrl("documents", d.file_name || d.url), so a
      // file_name holding a bare filename signs a path that does not exist
      // and every View link breaks.
      file_name: path,
      url: path,
      property: property || null,
      property_id: propertyId,
      type: type,
      uploaded_at: new Date().toISOString(),
      // A utility statement carries the owner's account number and usage
      // history. It is not the tenant's to read unless somebody says so.
      tenant_visible: false,
    }]).select("id").single();
    if (error) return { id: null, error: error.message };
    return { id: data.id, error: null };
  } catch (e) {
    return { id: null, error: String(e?.message || e) };
  }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

function workerAuthorised(req) {
  const expected = process.env.AI_WORKER_TOKEN || "";
  // Refuse rather than default-open: an unset secret must not mean
  // "anyone may drain the queue".
  if (!expected || expected.length < 24) return false;
  return safeEqual(req.headers["x-worker-token"], expected);
}


// suggestion_status defaults to the STRING "none", not NULL. Every check
// of "does this already have a suggestion?" has to go through here, or a
// truthiness test quietly answers yes for everything.
function hasSuggestion(status) {
  return Boolean(status) && status !== "none";
}

// Write a suggestion onto a transaction. One writer for both paths --
// history and model -- so the guards (already decided, already suggested)
// cannot drift apart between them.
async function writeSuggestion(sb, companyId, txnId, sug) {
  const { data: txn } = await sb.from("bank_feed_transaction")
    .select("id, raw_payload_json, status, suggestion_status").eq("id", txnId)
    .eq("company_id", companyId).maybeSingle();
  if (!txn) return { written: false, reason: "the transaction no longer exists" };
  if (txn.status !== "for_review") return { written: false, reason: `transaction is ${txn.status}` };
  if (hasSuggestion(txn.suggestion_status) && txn.suggestion_status !== "suggested_ai") {
    return { written: false, reason: `a rule already suggested (${txn.suggestion_status})` };
  }

  const payload = { ...(txn.raw_payload_json || {}) };
  payload._suggestion = { type: "assign", classId: null, ...sug };

  const { error } = await sb.from("bank_feed_transaction").update({
    suggestion_status: "suggested_ai", raw_payload_json: payload,
  }).eq("id", txn.id).eq("company_id", companyId);
  return error ? { written: false, reason: error.message } : { written: true };
}

// Turn a categorise_txn result into a suggestion on the bank transaction.
//
// The model returns an account CODE, never an id. Codes are short, stable
// and checkable against the chart of accounts, so an invented one is
// caught here instead of being written to the books. An id would have
// invited a hallucination that looks exactly like a real uuid.
async function applySuggestion(sb, job, output) {
  const code = output.account_code == null ? "" : String(output.account_code).trim();
  if (!code) return { written: false, reason: "model declined to pick an account" };

  const { data: accounts } = await sb.from("acct_accounts")
    .select("id, code, name, type").eq("company_id", job.company_id);
  const account = (accounts || []).find(a => String(a.code).trim() === code);
  // An unknown code is the model inventing one. Refuse it rather than
  // guessing at what it meant.
  if (!account) return { written: false, reason: `no account with code "${code}"` };

  // Which property a transaction belongs to, decided by three paths in
  // descending authority. Each fires only when the one before it is silent,
  // and any of them may come up blank -- a wrong property is worse than none,
  // because a reviewer accepts it and every charge after it inherits the
  // mistake. When all three are silent the category is still suggested; the
  // property is simply left for a person to fill.
  //
  // The bank text is where the answer lives. Rent arrives tagged with a
  // person ("Zelle payment from ANA J PRECIADO for Rent") or an address
  // ("...for 6958 Hawthorne Street"), never a class id, so every path reads
  // that text rather than asking the model, which when asked answered with
  // account names ("Rental Income") and ignored the property list entirely.
  let classId = null;
  const haystack = ` ${`${job.input?.description || ""} ${job.input?.payee || ""}`.toLowerCase()} `;
  const wholeWord = (w) => {
    const t = String(w).toLowerCase().trim();
    if (t.length < 2) return false;
    return new RegExp(`[^a-z0-9]${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9]`).test(haystack);
  };

  // (B) HISTORY. What this company has DONE BEFORE, ranked by measured
  // reliability -- tenant 99%, vendor+memo+amount 85%, vendor+memo 81%.
  // Threshold lowered 0.80 -> 0.70: still a clear majority, but it no longer
  // needs near-certainty to offer a property a reviewer can accept or reject.
  // This is also where a RELATIVE's name is learned: once a payment they sent
  // is accepted and posted, their name sits on a journal line against the
  // property, and the next payment from them resolves here by name.
  const { data: classHits } = await sb.rpc("suggest_class_from_history", {
    p_company_id: job.company_id,
    p_text: job.input?.description || "",
    p_entity_name: job.input?.payee || null,
    p_amount: job.input?.amount ?? null,
    p_min_support: 2,
  });
  const topClass = (classHits || [])[0];
  if (topClass && Number(topClass.reliability) >= 0.7) classId = topClass.class_id;

  // (A) TENANT NAME -> their property. The active roster, so it resolves a
  // tenant with no posted history yet. A tenant matches when both their first
  // and last name appear as whole words -- tolerant of a middle initial
  // ("Ana J Preciado"), strict enough that a bare common first name does not
  // fire on its own. Two tenants matching two DIFFERENT properties is
  // ambiguous and refused; two rows for the same person at one property
  // (a duplicate record) collapse to one class and resolve cleanly.
  if (!classId && haystack.trim()) {
    const { data: tenants } = await sb.from("tenants")
      .select("name, properties:property_id(class_id)")
      .eq("company_id", job.company_id)
      .eq("lease_status", "active")
      .is("archived_at", null);
    const matched = new Set();
    let last = null;
    for (const t of tenants || []) {
      const cls = t.properties?.class_id;
      if (!cls) continue;
      const toks = String(t.name || "").toLowerCase().split(/\s+/).filter((x) => x.length >= 2);
      if (toks.length < 2) continue;
      if (wholeWord(toks[0]) && wholeWord(toks[toks.length - 1])) { matched.add(cls); last = cls; }
    }
    if (matched.size === 1) classId = last;
  }

  // (C) ADDRESS in the text. A relative pays and the memo names the property
  // ("for 6508 Corkley Rd"). First an exact containment of the whole class
  // name; then, because the memo usually carries only the street and the
  // class name carries the full city/state/zip, the house-number-plus-street
  // signature ("6508 corkley"). A house number is unique to its street, so
  // the signature is specific -- but two condo units share it, so a signature
  // that hits more than one class is ambiguous and refused.
  if (!classId && haystack.trim()) {
    const { data: classes } = await sb.from("acct_classes")
      .select("id, name").eq("company_id", job.company_id);
    const named = (classes || []).filter((c) => c.name && String(c.name).trim().length >= 6);
    // Longest name first, so "100 Oak Street, Unit A" wins over "100 Oak Street".
    const exact = [...named]
      .sort((a, b) => String(b.name).length - String(a.name).length)
      .find((c) => haystack.includes(` ${String(c.name).trim().toLowerCase()} `)
                || haystack.includes(String(c.name).trim().toLowerCase()));
    if (exact) {
      classId = exact.id;
    } else {
      const sigMatches = new Set();
      let sigClass = null;
      for (const c of named) {
        const m = String(c.name).trim().toLowerCase().match(/^(\d{1,6})\s+([a-z]+)/);
        if (!m) continue;
        // The house number must stand alone (not the tail of a longer number)
        // and the street must be a whole word: "6958 hawthorne", not the "1
        // main" buried inside "61 main".
        const sig = new RegExp(`(^|[^0-9])${m[1]}\\s+${m[2]}([^a-z0-9]|$)`);
        if (sig.test(haystack)) { sigMatches.add(c.id); sigClass = c.id; }
      }
      if (sigMatches.size === 1) classId = sigClass;
    }
  }

  // The customer on the books is the TENANT of this property, never whoever's
  // name is on the transfer -- a relative sending a tenant's rent is noise,
  // not a new customer. Income only: an expense at a property is owed to a
  // vendor, not the tenant, so it is left blank here. Attached only when the
  // property has exactly one active tenant; co-tenants on separate rows or an
  // empty unit leave it for a person to decide.
  let entity = null;
  if (classId && account.type === "Revenue") {
    const { data: props } = await sb.from("properties")
      .select("id").eq("company_id", job.company_id).eq("class_id", classId);
    const propIds = (props || []).map((p) => p.id);
    if (propIds.length) {
      const { data: tens } = await sb.from("tenants")
        .select("id, name").eq("company_id", job.company_id)
        .in("property_id", propIds)
        .eq("lease_status", "active").is("archived_at", null);
      if ((tens || []).length === 1) {
        entity = { type: "customer", id: String(tens[0].id), name: tens[0].name || "" };
      }
    }
  }

  const { data: txn } = await sb.from("bank_feed_transaction")
    .select("id, raw_payload_json, status, suggestion_status").eq("id", job.subject_id)
    .eq("company_id", job.company_id).maybeSingle();
  if (!txn) return { written: false, reason: "the transaction no longer exists" };
  // Do not overwrite a decision a human already made.
  if (txn.status !== "for_review") return { written: false, reason: `transaction is ${txn.status}` };
  // Nor a rule's answer. A rule is exact and was written deliberately; by
  // the time this returns, one may have been applied. Checked here as well
  // as in the client because the client is not the only possible caller.
  //
  // "none" is a STRING in this column, not NULL -- that is the default. A
  // plain truthiness check treats it as "already suggested" and silently
  // blocks every write, which is exactly what it did.
  if (hasSuggestion(txn.suggestion_status) && txn.suggestion_status !== "suggested_ai") {
    return { written: false, reason: `a rule already suggested (${txn.suggestion_status})` };
  }

  const payload = { ...(txn.raw_payload_json || {}) };
  payload._suggestion = {
    type: "assign",
    accountId: account.id,
    accountName: account.name,
    classId,
    entityType: entity?.type || "",
    entityId: entity?.id || "",
    entityName: entity?.name || "",
    memo: output.memo ? String(output.memo).slice(0, 120) : "",
    source: "housy",
    confidence: typeof output.confidence === "number" ? output.confidence : null,
  };

  const { error } = await sb.from("bank_feed_transaction").update({
    suggestion_status: "suggested_ai",
    raw_payload_json: payload,
  }).eq("id", txn.id).eq("company_id", job.company_id);
  if (error) return { written: false, reason: error.message };
  return { written: true, account: account.code, classId };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const action = String(req.query?.action || "");
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  const sb = admin();
  if (!sb) return res.status(500).json({ error: "server is not configured for database access" });

  const isWorker = WORKER_ACTIONS.has(action);
  if (isWorker) {
    if (!workerAuthorised(req)) return res.status(401).json({ error: "unauthorized" });
  } else if (!CRON_ACTIONS.has(action) && !body.companyId) {
    return res.status(400).json({ error: "companyId is required" });
  }
  const { companyId } = body;

  try {
    if (action === "ingest") {
      const { sourceTable, sourceId, sourceName, text } = body;
      if (!sourceTable || !sourceId) return res.status(400).json({ error: "sourceTable and sourceId are required" });
      const r = await ingestChunks(sb, { companyId, sourceTable, sourceId, sourceName, text });
      return res.status(r.ok ? 200 : 500).json(r);
    }

    if (action === "search") {
      const { query, limit = 6, sourceId = null } = body;
      if (!query) return res.status(400).json({ error: "query is required" });
      const { data, error } = await sb.rpc("search_doc_chunks", {
        p_company_id: companyId, p_query: query, p_limit: limit, p_source_id: sourceId,
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, chunks: data || [] });
    }

    // ---- queue a job for the worker ------------------------------------
    // Returns immediately with the row. Nothing runs the model here; that
    // is the whole point.
    if (action === "enqueue") {
      const { kind, subjectTable = null, subjectId = null, input = {}, priority = 0 } = body;
      if (!kind) return res.status(400).json({ error: "kind is required" });

      // Ingest the text for retrieval at the same time. A document Housy
      // has read should be answerable questions about, and doing it here
      // means the chunk store fills as a side effect of normal use rather
      // than needing its own pass over everything.
      //
      // Failure is not fatal: the extraction is the job the user asked
      // for, and retrieval is a bonus on top of it.
      if (input && input.text && subjectTable && subjectId) {
        await ingestChunks(sb, {
          companyId, sourceTable: subjectTable, sourceId: subjectId,
          sourceName: input.source_name, text: input.text,
        }).catch(() => {});
      }
      const { data: job, error } = await sb.from("ai_jobs").insert([{
        company_id: companyId,
        kind,
        status: "queued",
        subject_table: subjectTable,
        subject_id: subjectId === null ? null : String(subjectId),
        input,
        priority,
        created_by: body.userEmail || null,
      }]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(202).json({ ok: true, job });
    }

    // ---- poll one job --------------------------------------------------
    // Company-scoped: a job id alone must not let one company read
    // another's work.
    if (action === "job-status") {
      const { jobId } = body;
      if (!jobId) return res.status(400).json({ error: "jobId is required" });
      const { data, error } = await sb.from("ai_jobs")
        .select("*").eq("id", jobId).eq("company_id", companyId).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "no such job for this company" });
      return res.status(200).json({ ok: true, job: data });
    }

    // ---- list the review queue -----------------------------------------
    if (action === "jobs") {
      const { status = null, limit = 50 } = body;
      let q = sb.from("ai_jobs").select("*").eq("company_id", companyId)
        .order("created_at", { ascending: false }).limit(Math.min(Number(limit) || 50, 200));
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, jobs: data || [] });
    }

    // ---- code transactions: history first, model only if it is silent ---
    //
    // MEASURED on 16,548 real journal lines (leave-one-out, so out of
    // sample): 83% of transactions have a precedent, and the most-common
    // account for that precedent is right 93.4% of the time.
    //
    // So history is not a hint to feed the model -- it IS the answer for
    // most transactions, it is instant, and it can say why: "Gas, because
    // all 28 previous Washington Gas payments went there." The model is
    // for the ~17% with no precedent at all, which is the only part where
    // a guess beats nothing.
    // CRON: queue Gemma on whatever the cheap tiers cannot explain.
    //
    // Lives here rather than in its own route because Vercel's Hobby plan
    // allows 12 serverless functions and the project is at the limit --
    // the same reason plaid-link carries both its actions.
    //
    // Order matters and this is deliberately LAST: a user's rule, then
    // suggest_accounts_for_pending (history + counterparty + the property
    // the memo names) -- both instant and able to say why -- and only then
    // the model, at ~20s a transaction, on the residue. Running the model
    // first would spend hours guessing at what a regex settles exactly.
    //
    // It QUEUES rather than answers: hundreds of transactions is hours of
    // box time, which belongs overnight. Nothing here posts; the worker
    // writes a suggestion that pre-fills the form for a person to confirm.
    if (action === "sweep") {
      const CRON_SECRET = process.env.CRON_SECRET || "";
      const authHeader = req.headers.authorization || "";
      const bodySecret = (body && body.cron_secret) || "";
      const cronOk = CRON_SECRET && CRON_SECRET.length >= 8 && (
        isCronSecretBearer(authHeader, CRON_SECRET) || cronSecretMatches(bodySecret, CRON_SECRET)
      );
      if (!cronOk) return res.status(401).json({ error: "Unauthorized" });

      const MAX_PER_RUN = Number(process.env.AI_SWEEP_MAX || 200);
      const MAX_PER_COMPANY = Number(process.env.AI_SWEEP_MAX_PER_COMPANY || 60);
      // company-scope-exempt: a cron has no current company. It walks every
      // company that has pending work and carries company_id onto each job.
      // DISTINCT companies, asked of the database.
      //
      // This selected company_id off up to 5000 for_review rows and
      // de-duplicated them in JS. .limit(5000) does not raise PostgREST's
      // 1000-row cap, so the scan saw the first 1000 ROWS -- and since one
      // busy company can hold hundreds of them, every company sorted after
      // those 1000 was silently skipped by the nightly sweep. Sigma Housing
      // alone has 921.
      //
      // The question was always "which companies have pending work", not
      // "give me a thousand rows and let me work it out": a grouped aggregate
      // answers it exactly, in one request, at any size.
      // A GROUPED AGGREGATE, at last. The comment above described this fix
      // and the code underneath it kept doing the row scan: select company_id
      // off for_review rows, order by company_id, limit 1000, de-duplicate in
      // JS. That is a row limit, not a company limit. One company holds 3,514
      // pending rows, so all thousand belonged to it and every company
      // sorting after it was invisible -- companies_scanned came back as 1,
      // every night. Sigma Housing sorts ninth, has 911 transactions waiting,
      // and had never once been swept: one AI job existed in the whole table.
      //
      // The RPC returns one row per company, busiest first, so a run that
      // hits its cap spends it where the backlog is rather than on whoever
      // sorts first alphabetically.
      const { data: companies, error: cErr } = await sb
        .rpc("companies_with_pending_ai_work", { p_min: 1 });
      if (cErr) return res.status(500).json({ error: cErr.message });

      const companyIds = (companies || []).map(c => c.company_id);
      let queued = 0, skippedHistory = 0, alreadyQueued = 0;
      const perCompany = {};
  
      for (const companyId of companyIds) {
        if (queued >= MAX_PER_RUN) break;
  
        // Ask the cheap tiers FIRST and exclude anything they answer. Passing
        // p_txn_ids null lets one query cover the whole company.
        const { data: suggested } = await sb.rpc("suggest_accounts_for_pending", {
          p_company_id: companyId, p_txn_ids: null,
          p_min_support: 3, p_min_agree: 0.6, p_allow_siblings: true,
        });
        const explained = new Set((suggested || []).map(s => s.transaction_id));
  
        const { data: pending } = await sb
          .from("bank_feed_transaction")
          .select("id, posted_date, amount, direction, bank_description_raw, bank_description_clean, payee_normalized")
          .eq("company_id", companyId)
          .eq("status", "for_review")
          .in("suggestion_status", ["none"])
          .order("posted_date", { ascending: false })
          .limit(MAX_PER_COMPANY * 3);
  
        const residue = (pending || []).filter(t => !explained.has(t.id));
        skippedHistory += (pending || []).length - residue.length;
        if (!residue.length) continue;
  
        // Don't re-queue what is already waiting or running.
        const ids = residue.map(t => String(t.id));
        const { data: existing } = await sb
          .from("ai_jobs")
          .select("subject_id")
          .eq("company_id", companyId)
          .eq("kind", "categorise_txn")
          .in("status", ["queued", "running", "proposed"])
          .in("subject_id", ids.slice(0, 500));
        const waiting = new Set((existing || []).map(j => j.subject_id));
  
        // The chart of accounts the model may choose from. Only income and
        // expense: a transfer between your own accounts is not a coding
        // decision and has its own flow.
        const { data: accounts } = await sb
          .from("acct_accounts")
          .select("code, name, type")
          .eq("company_id", companyId)
          .in("type", ["Revenue", "Expense", "Other Income"]);
  
        const rows = [];
        for (const t of residue) {
          if (rows.length >= MAX_PER_COMPANY || queued + rows.length >= MAX_PER_RUN) break;
          if (waiting.has(String(t.id))) { alreadyQueued++; continue; }
          const description = t.bank_description_clean || t.bank_description_raw || "";
          if (!description.trim()) continue;      // nothing to reason about
          rows.push({
            company_id: companyId,
            kind: "categorise_txn",
            status: "queued",
            subject_table: "bank_feed_transaction",
            subject_id: String(t.id),
            input: {
              date: t.posted_date, direction: t.direction,
              amount: Math.abs(Number(t.amount) || 0),
              description, payee: t.payee_normalized || "",
              accounts: (accounts || []).map(a => ({ code: a.code, name: a.name, type: a.type })),
            },
            priority: 0,
            created_by: "cron:ai-sweep",
          });
        }
        if (!rows.length) continue;
  
        const { error: insErr } = await sb.from("ai_jobs").insert(rows);
        if (insErr) { console.error("ai-sweep insert failed for", companyId, insErr.message); continue; }
        queued += rows.length;
        perCompany[companyId] = rows.length;
      }
  
      return res.status(200).json({
        companies_scanned: companyIds.length,
        queued,
        skipped_explained_by_history: skippedHistory,
        already_queued: alreadyQueued,
        per_company: perCompany,
      });
    }

    if (action === "code-transactions") {
      const { transactions = [], accounts = [], minSupport = 3, minAgreement = 0.7 } = body;
      if (!Array.isArray(transactions) || !transactions.length) {
        return res.status(400).json({ error: "transactions is required" });
      }

      let fromHistory = 0, queued = 0, skipped = 0;
      const failures = [];

      for (const t of transactions) {
        const text = `${t.description || ""} ${t.payee || ""}`.trim();
        if (!text) { skipped++; continue; }

        const { data: hits } = await sb.rpc("suggest_account_from_history", {
          p_company_id: companyId, p_text: text, p_min_support: 1,
        });
        const top = (hits || [])[0];

        // Confident enough only when the precedent is both REPEATED and
        // consistent. One prior line that happened to go somewhere is not
        // a pattern, and a 50/50 split is not an answer.
        const confident = top
          && Number(top.support) >= minSupport
          && Number(top.agreement) >= minAgreement;

        if (confident) {
          const { data: cls } = await sb.rpc("suggest_class_from_history", {
            p_company_id: companyId, p_text: t.description || "",
            p_entity_name: t.payee || null, p_amount: t.amount ?? null, p_min_support: 2,
          });
          const topCls = (cls || [])[0];
          const r = await writeSuggestion(sb, companyId, t.id, {
            classId: topCls && Number(topCls.reliability) >= 0.8 ? topCls.class_id : null,
            classSource: topCls && Number(topCls.reliability) >= 0.8 ? topCls.method : null,
            accountId: top.account_id, accountName: top.account_name,
            memo: (t.description || "").slice(0, 120),
            source: "history",
            support: Number(top.support),
            agreement: Number(top.agreement),
            method: top.method,
          });
          r.written ? fromHistory++ : failures.push({ id: t.id, reason: r.reason });
          continue;
        }

        // No usable precedent. This is where the model earns its keep.
        if (!accounts.length) { skipped++; continue; }
        const { error: insErr } = await sb.from("ai_jobs").insert([{
          company_id: companyId, kind: "categorise_txn", status: "queued",
          subject_table: "bank_feed_transaction", subject_id: String(t.id),
          priority: 5, created_by: body.userEmail || null,
          input: { date: t.date, direction: t.direction, amount: t.amount,
                   description: t.description, payee: t.payee, accounts },
        }]);
        insErr ? failures.push({ id: t.id, reason: insErr.message }) : queued++;
      }

      return res.status(200).json({ ok: true, fromHistory, queued, skipped, failures });
    }

    // ---- ask a question of the DATA -------------------------------------
    //
    // The model never writes SQL. It picks one question from a catalogue
    // of reviewed queries and fills in the blanks -- classification, which
    // it measured well at, rather than code generation, which it did not.
    //
    // The reason is correctness before safety: a small model writes
    // PLAUSIBLE SQL that is subtly wrong far more often than it writes SQL
    // that fails, and a query returning a confident wrong number is the
    // worst output there is, because nothing about it looks like an error.
    // A forgotten "archived_at IS NULL" counts archived leases as active
    // and still returns a tidy figure.
    if (action === "ask-data") {
      if (!aiConfigured()) return res.status(503).json({ error: "no model endpoint configured (AI_BASE_URL)" });
      const { question } = body;
      if (!question || !String(question).trim()) return res.status(400).json({ error: "question is required" });

      const { data: catalog, error: cErr } = await sb.from("ai_question_templates")
        .select("key, description, examples, params").eq("enabled", true);
      if (cErr) return res.status(500).json({ error: cErr.message });
      if (!catalog?.length) return res.status(200).json({ ok: true, answered: false, reason: "no questions are catalogued" });

      const menu = catalog.map(c =>
        `${c.key}: ${c.description}` +
        (c.examples?.length ? `\n    e.g. ${c.examples.slice(0, 3).join(" / ")}` : "") +
        (Object.keys(c.params || {}).length ? `\n    params: ${JSON.stringify(c.params)}` : "")
      ).join("\n");

      const pick = await askJson({
        system:
          "Choose which catalogued question answers the user, and extract any parameters.\n" +
          // The honest refusal matters more than the coverage: answering
          // the wrong question confidently is worse than saying no.
          "If NONE of them answers it, set key to null. Never pick one that is merely related.\n" +
          "Only use parameter names listed for the question you chose.",
        schemaHint: '{"key":string|null,"params":object,"why":string}',
        prompt: `Questions available:\n${menu}\n\nThe user asked: ${question}`,
      });
      if (!pick.ok) return res.status(502).json({ error: pick.error || "the model did not answer" });

      const chosen = pick.data?.key && catalog.find(c => c.key === pick.data.key);
      if (!chosen) {
        return res.status(200).json({
          ok: true, answered: false,
          reason: pick.data?.why || "that is not something I can answer from your data yet",
          available: catalog.map(c => c.description),
        });
      }

      const { data: result, error: rErr } = await sb.rpc("run_ai_question", {
        p_company_id: companyId, p_key: chosen.key, p_params: pick.data.params || {},
      });
      if (rErr) return res.status(500).json({ error: rErr.message });

      // "No rows" and "no data to search" are DIFFERENT answers, and
      // conflating them is how "you have no arrears" gets said to someone
      // whose leases were simply never loaded.
      const rows = result?.rows || [];
      return res.status(200).json({
        ok: true, answered: true, key: chosen.key, question: chosen.description,
        params: pick.data.params || {}, rows, count: rows.length,
        empty_means: rows.length === 0
          ? "nothing matched — check the underlying records exist before reading this as a clean bill of health"
          : null,
        model: pick.model, durationMs: pick.durationMs,
      });
    }

    // ---- ask a question of the documents --------------------------------
    // SYNCHRONOUS, unlike everything else here, and deliberately.
    // Retrieval sends a handful of passages rather than a whole document,
    // so the prompt is small and the answer comes back in seconds -- well
    // inside the ~100s an HTTP request survives. Queueing it would mean a
    // spinner and a poll for something that is effectively instant.
    if (action === "ask") {
      if (!aiConfigured()) return res.status(503).json({ error: "no model endpoint configured (AI_BASE_URL)" });
      const { question, sourceId = null, limit = 6 } = body;
      if (!question || !String(question).trim()) return res.status(400).json({ error: "question is required" });

      // Embed the question so retrieval can match meaning. ~90ms, and a
      // null just degrades this to the lexical search it used to be.
      const qVec = await embed(String(question));
      const { data: chunks, error: sErr } = await sb.rpc("search_doc_chunks_hybrid", {
        p_company_id: companyId, p_query: String(question),
        p_embedding: toVectorLiteral(qVec),
        p_limit: Math.min(Number(limit) || 6, 10), p_source_id: sourceId,
      });
      if (sErr) return res.status(500).json({ error: sErr.message });
      // No passage means no grounded answer is possible. Say so rather
      // than letting the model answer from nothing, which is exactly how
      // it invents a clause that was never in the lease.
      if (!chunks || !chunks.length) {
        return res.status(200).json({ ok: true, answer: null, chunks: [],
          reason: "nothing in the documents matched that question" });
      }

      const passages = chunks.map((c, i) =>
        `[${i + 1}] from ${c.source_name || c.source_table}:\n${c.content}`).join("\n\n");

      const r = await askJson({
        system:
          "Answer the question using ONLY the passages below. They are excerpts from " +
          "the user's own property documents.\n" +
          // The failure that matters here is a confident answer drawn from
          // general knowledge of leases rather than from THIS lease.
          "If the passages do not contain the answer, say so in `answer` and set " +
          "`found` to false. Do not answer from general knowledge about leases.\n" +
          "`quote` must be copied VERBATIM from a passage -- it is what the reader " +
          "checks you against. `passage` is which numbered passage you used.",
        schemaHint: '{"answer":string,"found":boolean,"quote":string|null,"passage":number|null}',
        prompt: `Passages:\n${passages}\n\nQuestion: ${question}`,
      });
      if (!r.ok) return res.status(502).json({ error: r.error || "the model did not answer" });

      return res.status(200).json({
        ok: true,
        answer: r.data?.answer || null,
        found: r.data?.found !== false,
        quote: r.data?.quote || null,
        passage: r.data?.passage ?? null,
        chunks: chunks.map(c => ({ source_name: c.source_name, source_table: c.source_table,
                                   source_id: c.source_id, content: c.content, rank: c.rank,
                                   lexical: c.lexical, semantic: c.semantic })),
        semanticSearch: Boolean(qVec),
        model: r.model, durationMs: r.durationMs,
      });
    }

    // ---- a worker records a utility bill reading -------------------------
    //
    // The sweep runs on the Oracle box, which deliberately holds NO
    // database credentials -- the service key bypasses RLS and that box is
    // a second Always Free tenancy that can be reclaimed with little
    // warning. So readings come back through here with the worker token,
    // the same way jobs do.
    //
    // Records the bill on the utility row and nothing else. Utilities are
    // not booked into accounting, so this never touches the ledger.
    if (action === "record-reading") {
      const { companyId: cid, provider, account = null, property = null,
              outcome, amount = null, due = null, error: readErr = null } = body;
      if (!cid || !provider || !outcome) {
        return res.status(400).json({ error: "companyId, provider and outcome are required" });
      }
      const { data, error } = await sb.rpc("record_utility_reading", {
        p_company_id: cid, p_provider: provider, p_account: account,
        p_outcome: outcome, p_amount: amount, p_due: due,
        p_error: readErr, p_property: property,
      });
      if (error) return res.status(500).json({ error: error.message });
      const r = Array.isArray(data) ? data[0] : data;

      // Hand back the bill this reading landed on, so the caller can attach
      // the statement to it. Done here rather than by widening the RPC's
      // return type, which would mean dropping and recreating a function the
      // sweep depends on.
      let billId = null;
      if (r && r.updated && r.utility_id) {
        const { data: acct } = await sb.from("utility_accounts")
          .select("id").eq("legacy_utility_id", r.utility_id).maybeSingle();
        if (acct?.id) {
          const { data: b } = await sb.from("utility_bills")
            .select("id").eq("utility_account_id", acct.id).is("archived_at", null)
            .order("read_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
          billId = b?.id || null;
        }
      }
      return res.status(200).json({ ok: true, ...r, billId });
    }

    // ---- keep the statement ---------------------------------------------
    // The scraper reads a number off a screen and throws the page away, so a
    // disputed charge has nothing behind it. utility_bills.pdf_storage_path
    // was designed for this and never used.
    //
    // The worker cannot reach storage or the database directly -- that is the
    // point of the box being an appliance -- so it posts the rendered page
    // here and this route files it.
    if (action === "attach-bill-document") {
      const { companyId: cid, billId, pdfBase64, filename } = body;
      if (!cid || !billId || !pdfBase64) {
        return res.status(400).json({ error: "companyId, billId and pdfBase64 are required" });
      }
      const buf = Buffer.from(String(pdfBase64), "base64");
      // A statement is a page, not a payload. 12 MB is generous for one and
      // small enough that a runaway capture cannot fill the bucket.
      if (!buf.length || buf.length > 12 * 1024 * 1024) {
        return res.status(400).json({ error: "document must be between 1 byte and 12 MB" });
      }
      // PDF magic bytes. Trusting the extension is how something that is not
      // a document ends up in the documents bucket.
      if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
        return res.status(400).json({ error: "not a PDF" });
      }

      // The bill must exist and belong to the company being claimed, so a
      // worker token cannot file a document against somebody else's books.
      const { data: bill, error: billErr } = await sb
        .from("utility_bills").select("id, company_id, property, provider, statement_period")
        .eq("id", billId).eq("company_id", cid).maybeSingle();
      if (billErr) return res.status(500).json({ error: billErr.message });
      if (!bill) return res.status(404).json({ error: "no such bill for this company" });

      const safe = String(filename || `${bill.provider}-${bill.statement_period || "statement"}`)
        .replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      const path = `${cid}/utility-bills/${billId}-${Date.now()}-${safe}.pdf`;

      const { error: upErr } = await sb.storage.from("documents")
        .upload(path, buf, { contentType: "application/pdf", upsert: false });
      if (upErr) return res.status(500).json({ error: upErr.message });

      const { error: setErr } = await sb.from("utility_bills")
        .update({ pdf_storage_path: path, updated_at: new Date().toISOString() })
        .eq("id", billId).eq("company_id", cid);
      if (setErr) return res.status(500).json({ error: setErr.message });

      // FILE IT AS A DOCUMENT TOO.
      //
      // Setting pdf_storage_path put the statement in the bucket and made it
      // reachable from one column on the Utilities page -- and nowhere else.
      // It did not appear in the Documents module and was not filed against
      // the property, so from the outside the bills looked like they were
      // never stored at all.
      //
      // A failure here does not fail the call: the statement IS saved, and
      // losing the whole upload over its index row would be worse than an
      // unindexed statement. It is reported so the sweep can log it.
      const docRow = await fileUtilityDocument(sb, {
        companyId: cid, property: bill.property, path, safeName: safe,
        type: "Utility Bill",
        label: `${bill.provider}${bill.statement_period ? " " + bill.statement_period : ""} statement`,
      });

      return res.status(200).json({ ok: true, path, document_id: docRow.id || null, document_error: docRow.error || null });
    }

    // ---- record a confirmed portal payment ------------------------------
    //
    // Called by the payment worker AFTER the portal returned a confirmation.
    // It marks the bill paid and files the receipt as a document.
    //
    // It deliberately posts NO journal entry. The money leaving the bank
    // arrives on its own through the bank feed, and booking it here as well
    // would show the same payment twice -- once from this action and once
    // from the feed. The bill's own status, amount and confirmation number
    // are the record that it was paid; the ledger entry is the bank's.
    if (action === "record-utility-payment") {
      const { companyId: cid, paymentId, billId, amount, confirmation, paidOn,
              receiptBase64, receiptFilename } = body;
      if (!cid || !paymentId || !billId) {
        return res.status(400).json({ error: "companyId, paymentId and billId are required" });
      }
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "amount must be a positive number" });
      }

      // The payment row is the authority on what was approved. Trusting the
      // worker's reported amount would let a bug settle a bill for a figure
      // nobody approved.
      const { data: pay, error: payErr } = await sb.from("utility_payments")
        .select("id, company_id, bill_id, approved_amount, status")
        .eq("id", paymentId).eq("company_id", cid).maybeSingle();
      if (payErr) return res.status(500).json({ error: payErr.message });
      if (!pay) return res.status(404).json({ error: "no such payment for this company" });
      if (String(pay.bill_id) !== String(billId)) {
        return res.status(400).json({ error: "payment does not belong to that bill" });
      }
      if (Math.abs(Number(pay.approved_amount) - amt) > 0.005) {
        return res.status(400).json({
          error: `amount ${amt} does not match the approved ${pay.approved_amount}` });
      }

      const { data: bill, error: billErr } = await sb.from("utility_bills")
        .select("id, company_id, property, provider, statement_period, status, amount, amount_paid")
        .eq("id", billId).eq("company_id", cid).maybeSingle();
      if (billErr) return res.status(500).json({ error: billErr.message });
      if (!bill) return res.status(404).json({ error: "no such bill for this company" });

      // Already settled: say so and change nothing. A worker retrying after
      // a dropped response must not re-stamp a bill or file a second receipt.
      // 'partial' is deliberately NOT here: a part-paid bill must still
      // accept its next instalment. Only a fully settled one is a no-op.
      if (["paid", "settled"].includes(bill.status)) {
        return res.status(200).json({ ok: true, already: true, status: bill.status });
      }

      // The receipt, if the worker captured one.
      let receiptPath = null, receiptDocId = null, receiptError = null;
      if (receiptBase64) {
        const rbuf = Buffer.from(String(receiptBase64), "base64");
        if (!rbuf.length || rbuf.length > 12 * 1024 * 1024) {
          receiptError = "receipt must be between 1 byte and 12 MB";
        } else if (rbuf.slice(0, 5).toString("latin1") !== "%PDF-") {
          receiptError = "receipt is not a PDF";
        } else {
          const rsafe = String(receiptFilename || `${bill.provider}-receipt`)
            .replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
          receiptPath = `${cid}/utility-receipts/${billId}-${Date.now()}-${rsafe}.pdf`;
          const { error: rUp } = await sb.storage.from("documents")
            .upload(receiptPath, rbuf, { contentType: "application/pdf", upsert: false });
          if (rUp) { receiptError = rUp.message; receiptPath = null; }
          else {
            const d = await fileUtilityDocument(sb, {
              companyId: cid, property: bill.property, path: receiptPath, safeName: rsafe,
              type: "Utility Receipt",
              label: `${bill.provider}${bill.statement_period ? " " + bill.statement_period : ""} payment receipt`,
            });
            receiptDocId = d.id || null;
            if (d.error) receiptError = d.error;
          }
        }
      }

      const paidAt = paidOn ? new Date(String(paidOn) + "T12:00:00").toISOString()
                            : new Date().toISOString();

      // A PART PAYMENT MUST NOT MARK THE BILL PAID.
      //
      // amount_paid accumulates, and the status only becomes 'paid' once the
      // total actually covers the bill. Otherwise a $10 payment on a $27.66
      // bill reads as settled, the remaining $17.66 is invisible, and the
      // provider's late notice is the thing that tells you.
      const already = Number(bill.amount_paid) || 0;
      const totalPaid = Math.round((already + amt) * 100) / 100;
      const billTotal = Number(bill.amount) || 0;
      const covered = billTotal > 0 ? totalPaid >= billTotal - 0.005 : true;

      const { error: bUp } = await sb.from("utility_bills").update({
        status: covered ? "paid" : "partial",
        amount_paid: totalPaid,
        paid_at: paidAt,
        payment_confirmation: confirmation ? String(confirmation).slice(0, 200) : null,
        payment_method_selected: "portal_automation",
        updated_at: new Date().toISOString(),
      }).eq("id", billId).eq("company_id", cid);
      if (bUp) return res.status(500).json({ error: bUp.message });

      if (receiptPath) {
        await sb.from("utility_payments")
          .update({ receipt_storage_path: receiptPath })
          .eq("id", paymentId).eq("company_id", cid);
      }

      return res.status(200).json({
        ok: true, bill_status: covered ? "paid" : "partial",
        amount_paid: totalPaid, bill_amount: billTotal,
        remaining: billTotal > 0 ? Math.round((billTotal - totalPaid) * 100) / 100 : 0,
        receipt_path: receiptPath, receipt_document_id: receiptDocId,
        receipt_error: receiptError,
      });
    }

    // ---- what should the sweep read? -------------------------------------
    // The box cannot query utilities itself, so it asks. Returns only what
    // a sweep needs: provider, account number, property. No credentials.
    if (action === "sweep-targets") {
      const { companyId: cid, providers = [] } = body;
      if (!cid) return res.status(400).json({ error: "companyId is required" });
      // A utility flipped to the tenant but whose CLOSEOUT bill is still the
      // owner's (utility_accounts.final_bill_status='pending') must STILL be
      // swept -- that final statement is the owner's to capture and pay. Pull
      // those accounts' linked utilities.id and let them through the filter.
      const { data: pendingAccts } = await sb.from("utility_accounts")
        .select("legacy_utility_id")
        .eq("company_id", cid).eq("responsibility", "tenant").eq("final_bill_status", "pending")
        .is("archived_at", null).not("legacy_utility_id", "is", null);
      const pendingLegacyIds = (pendingAccts || []).map(a => a.legacy_utility_id).filter(Boolean);
      let orFilter = "responsibility.is.null,responsibility.not.in.(tenant,condo_fee)";
      if (pendingLegacyIds.length) orFilter += `,id.in.(${pendingLegacyIds.join(",")})`;
      let q = sb.from("utilities")
        .select("id, provider, property, account_number, responsibility")
        .eq("company_id", cid)
        // Archived rows are duplicates or retired accounts -- never swept.
        .is("archived_at", null)
        // A utility the TENANT is responsible for is not swept -- not our bill
        // to read, pay or chase. Nor is one COVERED BY THE CONDO FEE: there is
        // no separate statement to fetch. NULL responsibility falls through as
        // the owner's, which is the default everywhere else in the app. The
        // exception is a pending-final tenant utility, added by id above.
        .or(orFilter);
      if (providers.length) q = q.in("provider", providers);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      const targets = data || [];

      // Attach the date of each account's most recent bill so the sweep can
      // SKIP an account whose current statement is already on file. Utility
      // bills are monthly; re-reading and re-downloading every account every
      // day is wasted portal load. Linkage is
      // utilities.id -> utility_accounts.legacy_utility_id -> utility_bills.
      if (targets.length) {
        const legacyIds = targets.map(t => t.id);
        const { data: accts } = await sb.from("utility_accounts")
          .select("id, legacy_utility_id").in("legacy_utility_id", legacyIds);
        const acctByLegacy = new Map((accts || []).map(a => [a.legacy_utility_id, a.id]));
        const acctIds = (accts || []).map(a => a.id);
        const lastByAcct = new Map();
        if (acctIds.length) {
          const { data: bills } = await sb.from("utility_bills")
            .select("utility_account_id, created_at").in("utility_account_id", acctIds)
            .is("archived_at", null).order("created_at", { ascending: false });
          for (const b of (bills || [])) {
            if (!lastByAcct.has(b.utility_account_id)) lastByAcct.set(b.utility_account_id, b.created_at);
          }
        }
        for (const t of targets) {
          const aid = acctByLegacy.get(t.id);
          t.last_bill_at = aid ? (lastByAcct.get(aid) || null) : null;
        }
      }
      return res.status(200).json({ ok: true, targets });
    }

    // ---- worker reads ENCRYPTED portal credentials ---------------------
    //
    // So a browser box can sign itself back in without holding a Supabase
    // service key. The box has only ENCRYPTION_KEY; this returns the
    // ciphertext (never plaintext), which is useless without that key. The
    // key never leaves the box and the service key never reaches it -- the
    // most a compromise of this appliance yields is the encrypted blobs.
    if (action === "portal-credentials") {
      const { companyId: cid, provider = null } = body;
      if (!cid) return res.status(400).json({ error: "companyId is required" });
      let q = sb.from("utilities")
        .select("id, provider, account_number, username_encrypted, password_encrypted, "
              + "encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp")
        .eq("company_id", cid)
        .not("username_encrypted", "is", null)
        .not("password_encrypted", "is", null);
      // One portal login covers every account on it, so a provider filter is
      // optional -- the worker matches by its own aliases. Kept for callers
      // that want to narrow the payload.
      if (provider) q = q.ilike("provider", `%${String(provider)}%`);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, credentials: data || [] });
    }

    // ---- worker claims one job -----------------------------------------
    if (action === "claim") {
      const { worker, kinds = null } = body;
      if (!worker) return res.status(400).json({ error: "worker is required" });
      const { data, error } = await sb.rpc("claim_ai_job", {
        p_worker: String(worker),
        p_kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
      });
      if (error) return res.status(500).json({ error: error.message });
      const job = Array.isArray(data) ? data[0] : data;
      // 204 means "nothing to do" -- an ordinary, frequent answer, not an
      // error the worker should log or back off hard on.
      if (!job) return res.status(204).end();
      return res.status(200).json({ ok: true, job });
    }

    // ---- worker reports a result ---------------------------------------
    if (action === "complete") {
      const { worker, jobId, output = null, model = null, durationMs = null,
              confidence = null, error: jobError = null } = body;
      if (!worker || !jobId) return res.status(400).json({ error: "worker and jobId are required" });

      // Read the job BEFORE completing it: complete_ai_job clears the claim,
      // and a categorise_txn result needs the job's company and subject to
      // know which transaction it belongs to.
      const { data: job } = await sb.from("ai_jobs")
        .select("id, kind, company_id, subject_table, subject_id").eq("id", jobId).maybeSingle();

      const { data, error } = await sb.rpc("complete_ai_job", {
        p_id: jobId, p_worker: String(worker), p_output: output, p_model: model,
        p_duration: durationMs, p_confidence: confidence, p_error: jobError,
      });
      if (error) return res.status(500).json({ error: error.message });
      // false means the job was reclaimed by another worker while this one
      // was still running, so this result is stale and must be discarded.
      if (data !== true) return res.status(200).json({ ok: true, recorded: false });

      // A coded transaction becomes a SUGGESTION on the transaction itself,
      // in the same shape the rules engine already writes, rather than a
      // second thing to approve in Housy's queue.
      //
      // Why: the Banking screen already has a reviewed accept path that
      // builds the posting decision, the lines and the journal entry.
      // Duplicating that here would be a second, less-tested route into
      // the books. A suggestion is inert -- it only pre-fills a form -- so
      // the human gate stays exactly where it already is.
      if (job && job.kind === "categorise_txn" && !jobError && output) {
        const applied = await applySuggestion(sb, job, output);
        return res.status(200).json({ ok: true, recorded: true, suggestion: applied });
      }
      return res.status(200).json({ ok: true, recorded: true });
    }

    if (action === "extract-license") {
      if (!aiConfigured()) {
        return res.status(503).json({ error: "no model endpoint configured (AI_BASE_URL)" });
      }
      const { sourceTable = "documents", sourceId, sourceName, text } = body;
      if (!sourceId) return res.status(400).json({ error: "sourceId is required" });

      // Ingest first, so the document is searchable whether or not the
      // extraction succeeds -- retrieval has value on its own.
      await ingestChunks(sb, { companyId, sourceTable, sourceId, sourceName, text });

      const r = await extractLicense({ text, sourceName });

      // The job row is written on BOTH paths. A failed extraction that
      // leaves no trace is one nobody can debug, and "the AI did nothing"
      // is the least useful bug report there is.
      const row = {
        company_id: companyId,
        kind: "extract_license",
        status: r.ok ? "proposed" : "failed",
        subject_table: sourceTable,
        subject_id: String(sourceId),
        input: { source_name: sourceName || null, chars: String(text || "").length },
        output: r.ok ? r.output : null,
        model: r.model || null,
        duration_ms: r.durationMs || null,
        confidence: r.ok ? r.confidence : null,
        error: r.ok ? null : (r.error || "unknown").slice(0, 500),
        created_by: body.userEmail || null,
      };
      const { data: job, error: insErr } = await sb.from("ai_jobs").insert([row]).select().single();
      if (insErr) return res.status(500).json({ error: `recording the job: ${insErr.message}` });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, job, error: r.ok ? undefined : r.error });
    }

    return res.status(400).json({ error: `unknown action "${action}"` });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
};
