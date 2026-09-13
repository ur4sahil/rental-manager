// The service worker's cache name must change every deploy.
//
// sw.js's activate() deletes every cache whose name DIFFERS from
// CACHE_NAME. With a constant name nothing is ever evicted, so the app
// shell cached on a user's first visit is pinned there forever and the
// offline fallback slowly becomes a museum piece.
//
// It WAS constant: "housify-v4", unchanged since the day it was written,
// under a comment claiming it "bumps per deploy via the build step". No
// such step existed. A comment is not a mechanism, so this checks the
// mechanism.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const sw = readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
const m = sw.match(/const CACHE_NAME = "([^"]+)"/);
assert("sw.js declares a CACHE_NAME", !!m);
assert("CACHE_NAME is a build placeholder, not a literal",
  !!m && m[1].includes("__BUILD_ID__"),
  `found "${m && m[1]}" — a hardcoded name is never evicted, so every later deploy layers on a stale shell`);

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
assert("the build script stamps the service worker",
  /stamp-sw/.test(pkg.scripts.build || ""),
  `build is "${pkg.scripts.build}" — the placeholder would ship unreplaced`);
assert("the stamper exists", existsSync(path.join(ROOT, "scripts/stamp-sw.js")));

// activate() must still evict on mismatch, or the name is pointless.
assert("activate deletes caches that are not the current one",
  /keys\.filter\(\(k\) => k !== CACHE_NAME\)/.test(sw));

// If a build is present, it must be stamped — an unreplaced placeholder
// would make EVERY deploy share the literal name "housify-__BUILD_ID__",
// which is the original bug wearing a disguise.
const built = path.join(ROOT, "build/sw.js");
if (existsSync(built)) {
  const b = readFileSync(built, "utf8");
  assert("the built service worker carries no unreplaced placeholder",
    !b.includes("__BUILD_ID__"),
    "build/sw.js still has __BUILD_ID__ — the stamp step did not run");
  const bm = b.match(/const CACHE_NAME = "([^"]+)"/);
  assert("the built cache name is specific to this build",
    !!bm && bm[1] !== "housify-v4" && bm[1].length > "housify-".length);
  console.log(`      (built cache name: ${bm && bm[1]})`);
} else {
  console.log("SKIP  no build/ present — run npm run build to check stamping");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
