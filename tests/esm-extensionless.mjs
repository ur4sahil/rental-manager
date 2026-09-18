// Preload that makes src/ importable from a plain node test.
//
// Two things stand in the way, and both are properties of the test runner
// rather than faults in the app:
//
//   EXTENSIONLESS IMPORTS. src/ is written for a bundler, so it imports
//   "./helpers" with no extension. Node's ESM resolver requires one and
//   throws ERR_MODULE_NOT_FOUND. A resolve hook is the fix rather than
//   rewriting the app's imports to suit the runner.
//
//   BUILD-TIME ENV. src/supabase.js throws when REACT_APP_SUPABASE_URL and
//   _ANON_KEY are absent, and the import chain reaches it through helpers.
//   The bundler inlines those at build time; node has to be handed them.
//   They are taken from TEST_SUPABASE_*, never the production pair, so a
//   suite that does touch the network touches the test project.
//
// Why this matters more than one suite: test:code chains with &&, and
// property-import.test.js sat 14th of ~70. Its FATAL read like one test's
// problem while actually stopping the other ~56, the whole of test:db
// included. Most of the suite had not been running.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

if (!process.env.REACT_APP_SUPABASE_URL && process.env.TEST_SUPABASE_URL) {
  process.env.REACT_APP_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
}
if (!process.env.REACT_APP_SUPABASE_ANON_KEY && process.env.TEST_SUPABASE_ANON_KEY) {
  process.env.REACT_APP_SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;
}

register("./esm-extensionless-hook.mjs", pathToFileURL("./"));
