// The ai_jobs work queue: claiming, completing, and the races between them.
//
// These are the guarantees the whole Housy pipeline rests on. A queue that
// hands the same job to two workers wastes a 2-minute lease read; one that
// lets a stalled worker overwrite a newer worker's answer corrupts a
// proposal a human is about to approve. Neither failure is visible in
// normal use -- they only appear under concurrency, which is exactly when
// nobody is watching.
//
// Written to FIND those bugs, not to confirm the happy path: every test
// here is a race, a boundary, or a failure mode.
require("dotenv").config();
require("./sandbox-env");   // must precede any use of process.env.SUPABASE_*
const { createClient } = require("@supabase/supabase-js");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const COMPANY = "sandbox-llc";

// The LIVE worker polls this same database and claims whatever is queued.
// On the first run it claimed a fixture and ran the model on it, which made
// the kind-filter assertion fail for a reason that had nothing to do with
// the queue. These kinds are ones the worker never requests, so its poll
// loop and this suite stay out of each other's way.
const KIND = "queue_test";
const OTHER_KIND = "queue_test_other";
let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};

// Every row this file creates is tagged so cleanup can find them all even
// if an assertion throws halfway through.
const TAG = `queuetest-${Date.now()}`;

async function makeJob(extra = {}) {
  const { data, error } = await sb.from("ai_jobs").insert([{
    company_id: COMPANY, kind: KIND, status: "queued",
    subject_table: "leases", subject_id: TAG,
    input: { text: "irrelevant" }, ...extra,
  }]).select().single();
  if (error) throw new Error(`seed: ${error.message}`);
  return data;
}

const claim = (worker, kinds = [KIND]) =>
  sb.rpc("claim_ai_job", { p_worker: worker, p_kinds: kinds });

(async () => {
  // Leave no queued rows from a previous aborted run: they would be
  // claimable here and make results depend on run order.
  await sb.from("ai_jobs").delete().eq("subject_id", TAG);

  // ---- claiming ------------------------------------------------------
  {
    const job = await makeJob();
    const { data, error } = await claim("w1");
    const got = Array.isArray(data) ? data[0] : data;
    assert("claim returns the queued job", !error && got?.id === job.id, error?.message);
    assert("claim flips status to running", got?.status === "running");
    assert("claim records the worker", got?.claimed_by === "w1");
    assert("claim counts the attempt", got?.attempts === 1, `attempts=${got?.attempts}`);
    assert("claim stamps started_at", !!got?.started_at);
  }

  // THE race that matters. Two workers claiming at the same instant must
  // get two DIFFERENT jobs. Without FOR UPDATE SKIP LOCKED the second
  // blocks on the first's transaction and then re-reads a row that is no
  // longer queued -- or worse, both take the same one.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const a = await makeJob();
    const b = await makeJob();
    const [r1, r2] = await Promise.all([claim("race-1"), claim("race-2")]);
    const j1 = (Array.isArray(r1.data) ? r1.data[0] : r1.data)?.id;
    const j2 = (Array.isArray(r2.data) ? r2.data[0] : r2.data)?.id;
    assert("two concurrent claims both get work", !!j1 && !!j2, `${j1} / ${j2}`);
    assert("two concurrent claims get DIFFERENT jobs", j1 !== j2, `both got ${j1}`);
    assert("between them they took both jobs",
      new Set([j1, j2]).size === 2 && [a.id, b.id].every(id => [j1, j2].includes(id)));
  }

  // An empty queue must be an ordinary answer, not an error and not a row.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const { data, error } = await claim("w-empty");
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    assert("empty queue returns no row and no error", !error && rows.length === 0,
      error?.message || `got ${rows.length} rows`);
  }

  // Priority, then age. A high-priority job queued later still goes first.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    await makeJob({ priority: 0 });
    const urgent = await makeJob({ priority: 10 });
    const { data } = await claim("w-pri");
    const got = Array.isArray(data) ? data[0] : data;
    assert("higher priority is claimed first", got?.id === urgent.id);
  }

  // A worker may only claim the kinds it can actually run. Claiming a kind
  // it has no handler for would fail the job rather than leave it for a
  // worker that can do it.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const other = await makeJob({ kind: OTHER_KIND });
    const { data } = await claim("w-kind", [KIND]);
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    assert("a kind the worker did not ask for is not claimed", rows.length === 0,
      `claimed ${rows[0]?.kind}`);
    const { data: both } = await claim("w-kind", [KIND, OTHER_KIND]);
    const got = Array.isArray(both) ? both[0] : both;
    assert("a kind the worker DID ask for is claimed", got?.id === other.id);

    // null means "any kind", which on a shared database could take a real
    // job. Claim it, assert, then put anything that is not ours straight
    // back so the worker still gets it.
    await makeJob();
    const { data: anyData } = await claim("w-any", null);
    const anyJob = Array.isArray(anyData) ? anyData[0] : anyData;
    assert("null kinds claims anything", !!anyJob);
    if (anyJob && anyJob.subject_id !== TAG) {
      await sb.from("ai_jobs").update({
        status: "queued", claimed_by: null, claimed_at: null,
        attempts: Math.max(0, (anyJob.attempts || 1) - 1),
      }).eq("id", anyJob.id);
      console.log("   (returned a non-test job to the queue)");
    }
  }

  // ---- completing ----------------------------------------------------
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const job = await makeJob();
    await claim("w-done");
    const { data: ok } = await sb.rpc("complete_ai_job", {
      p_id: job.id, p_worker: "w-done", p_output: { monthly_rent: 2450 },
      p_model: "gemma4:e2b", p_duration: 1234, p_confidence: 0.9, p_error: null,
    });
    assert("complete by the claiming worker succeeds", ok === true);
    const { data: row } = await sb.from("ai_jobs").select("*").eq("id", job.id).single();
    assert("completed job lands in proposed", row?.status === "proposed", row?.status);
    assert("output is stored", row?.output?.monthly_rent === 2450);
    assert("claim is released", row?.claimed_by === null && row?.claimed_at === null);
  }

  // THE other race. A worker whose job was reclaimed (because it stalled)
  // must NOT be able to write its stale answer over the newer worker's.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const job = await makeJob();
    await claim("zombie");
    // Simulate the reclaim: a second worker now owns it.
    await sb.from("ai_jobs").update({ claimed_by: "fresh" }).eq("id", job.id);
    const { data: refused } = await sb.rpc("complete_ai_job", {
      p_id: job.id, p_worker: "zombie", p_output: { monthly_rent: 9999 },
      p_model: "stale", p_duration: 1, p_confidence: 1, p_error: null,
    });
    assert("a reclaimed job refuses the old worker's result", refused === false,
      `returned ${refused}`);
    const { data: row } = await sb.from("ai_jobs").select("*").eq("id", job.id).single();
    assert("the stale output was NOT written", row?.output === null,
      JSON.stringify(row?.output));
    assert("the job is still running for the new owner", row?.status === "running");
  }

  // An error must land as 'failed' WITH the message, not vanish. "The AI
  // did nothing" is the least debuggable bug report there is.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const job = await makeJob();
    await claim("w-fail");
    await sb.rpc("complete_ai_job", {
      p_id: job.id, p_worker: "w-fail", p_output: null, p_model: "gemma4:e2b",
      p_duration: 99, p_confidence: null, p_error: "model returned no parseable JSON",
    });
    const { data: row } = await sb.from("ai_jobs").select("*").eq("id", job.id).single();
    assert("a failed run is marked failed", row?.status === "failed");
    assert("the failure message is kept", /no parseable JSON/.test(row?.error || ""));
  }

  // Completing a job nobody claimed must not silently succeed.
  {
    await sb.from("ai_jobs").delete().eq("subject_id", TAG);
    const job = await makeJob();                       // still 'queued'
    const { data: r } = await sb.rpc("complete_ai_job", {
      p_id: job.id, p_worker: "nobody", p_output: { x: 1 },
      p_model: "m", p_duration: 1, p_confidence: null, p_error: null,
    });
    assert("completing an unclaimed job is refused", r === false, `returned ${r}`);
  }

  // ---- the status constraint ------------------------------------------
  {
    const { error } = await sb.from("ai_jobs").insert([{
      company_id: COMPANY, kind: KIND, status: "nonsense",
      subject_id: TAG, input: {},
    }]);
    assert("an unknown status is rejected by the database", !!error,
      error ? "" : "the insert was ACCEPTED — the check constraint is missing");
  }
  for (const s of ["queued", "running", "proposed", "approved", "rejected", "executing", "done", "failed"]) {
    const { error } = await sb.from("ai_jobs").insert([{
      company_id: COMPANY, kind: KIND, status: s, subject_id: TAG, input: {},
    }]);
    assert(`status '${s}' is accepted`, !error, error?.message);
  }

  // ---- cleanup ---------------------------------------------------------
  const { error: delErr } = await sb.from("ai_jobs").delete().eq("subject_id", TAG);
  assert("cleanup delete is permitted", !delErr, delErr?.message);
  const { data: left } = await sb.from("ai_jobs").select("id").eq("subject_id", TAG);
  assert("test rows cleaned up", (left || []).length === 0, `${(left || []).length} left`);

  console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SUITE ERROR:", e.message); process.exit(1); });
