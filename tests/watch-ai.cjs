// Poll the AI backlog until it drains.
//
// The first version had no error handling and died on a single connect
// timeout to Supabase after eight minutes. A watcher that cannot survive one
// flaky request is not a watcher -- and its death said nothing about the work,
// which carried on fine underneath.
const fs = require("fs");
const dotenv = require("dotenv");
const t = dotenv.parse(fs.readFileSync("./.env"));
const C = "f985cc7a-0d6b-4905-aea9-4b6eb9fd1dec";
const H = { apikey: t.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + t.SUPABASE_SERVICE_KEY, Prefer: "count=exact" };

const count = async (q) => {
  const r = await fetch(t.SUPABASE_URL + "/rest/v1/ai_jobs?select=id&company_id=eq." + C + "&" + q + "&limit=1", { headers: H });
  return Number((r.headers.get("content-range") || "/0").split("/")[1]) || 0;
};

(async () => {
  let consecutiveErrors = 0;
  for (let i = 0; i < 400; i++) {
    try {
      const left = await count("status=in.(queued,running)");
      const done = await count("status=eq.proposed");
      const failed = await count("status=eq.failed");
      consecutiveErrors = 0;
      if (i % 10 === 0 || left === 0) {
        console.log(new Date().toISOString().slice(11, 16), "remaining", left, "| proposed", done, "| failed", failed);
      }
      if (left === 0) { console.log("BACKLOG CLEAR —", done, "proposals waiting for review,", failed, "failed"); return; }
    } catch (e) {
      // Transient. Say so and keep going; the work is in the database, not here.
      consecutiveErrors++;
      console.log(new Date().toISOString().slice(11, 16), "poll failed (" + consecutiveErrors + "):", String(e.message).slice(0, 50));
      if (consecutiveErrors >= 10) { console.log("ten failures in a row — giving up on watching, not on the work"); return; }
    }
    await new Promise(r => setTimeout(r, 120000));
  }
  console.log("watcher reached its limit; check ai_jobs directly");
})();
