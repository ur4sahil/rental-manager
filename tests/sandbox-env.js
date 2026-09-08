// Point every test at the TEST Supabase project, and make production
// unreachable.
//
// 22 test files read process.env.SUPABASE_URL / SUPABASE_SERVICE_KEY.
// Those are PRODUCTION values, and the key is service_role, so it
// bypasses RLS. 13 of those files write. Every `npm run test:unit` was
// therefore reading and writing production, including one file that
// picked its company with an unordered `limit(1)` and inserted a journal
// entry into whatever came back.
//
// Rather than rewrite 22 clients, this module rewrites the environment
// they read, and is required at the top of each of them. Requiring it
// twice is harmless.
//
// It fails loudly instead of falling back. A test suite that silently
// writes to production is worse than one that refuses to start.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PROD_REF = "hoymytpyaudjvsgiiibn";
const TEST_REF = "vpeewlplgxthckpidhxo";

function die(lines) {
  console.error("\n" + "=".repeat(66));
  console.error("SANDBOX GUARD — refusing to run");
  console.error("=".repeat(66));
  lines.forEach(l => console.error(l));
  console.error("=".repeat(66) + "\n");
  process.exit(1);
}

const url = process.env.TEST_SUPABASE_URL;
if (!url) {
  die(["TEST_SUPABASE_URL is not set in tests/.env.",
       "Tests must never run against production."]);
}
if (url.includes(PROD_REF)) {
  die([`TEST_SUPABASE_URL points at the PRODUCTION project (${PROD_REF}).`,
       "Fix tests/.env before running anything."]);
}

const serviceKey = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!serviceKey) {
  die([
    "TEST_SUPABASE_SERVICE_KEY is not set in tests/.env.",
    "",
    "These tests need a service_role key, and the only one on disk",
    "belongs to PRODUCTION — which is exactly what must not be used.",
    "",
    "Get the TEST project's key:",
    "  https://supabase.com/dashboard/project/" + TEST_REF + "/settings/api-keys",
    "  copy the `service_role` key, then add to tests/.env:",
    "",
    "  TEST_SUPABASE_SERVICE_KEY=eyJ...",
    "",
    "Until then these tests do not run. That is deliberate: they used to",
    "run against production without saying so.",
  ]);
}
if (!serviceKey.includes(TEST_REF)) {
  // A JWT carries its project ref in the payload, so a production key
  // pasted into the test slot is caught here rather than at write time.
  try {
    const body = JSON.parse(Buffer.from(serviceKey.split(".")[1], "base64").toString());
    if (body.ref && body.ref !== TEST_REF) {
      die([`TEST_SUPABASE_SERVICE_KEY belongs to project "${body.ref}", not the test project (${TEST_REF}).`]);
    }
  } catch (_) { /* not a JWT we can read — the URL guard above still holds */ }
}

// Every test reads these names. Redirect them at the source.
process.env.SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_KEY = serviceKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

module.exports = { TEST_REF, PROD_REF };
