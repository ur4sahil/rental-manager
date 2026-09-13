#!/usr/bin/env node
// Stamp the service worker's cache name with the current build.
//
// public/sw.js ships "housify-__BUILD_ID__". CRA copies public/ into
// build/ verbatim, so this rewrites the COPY in build/ -- the source
// file keeps its placeholder and stays diffable.
//
// Why it matters: sw.js's activate() deletes every cache whose name
// differs from CACHE_NAME. With a constant name, the app shell cached on
// a user's first visit is never evicted, so the offline fallback is
// pinned to whatever the app looked like that day. The constant had not
// changed since it was written, despite a comment claiming a build step
// bumped it. This is that build step.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const swPath = path.join(__dirname, "..", "build", "sw.js");
if (!fs.existsSync(swPath)) {
  console.error("stamp-sw: build/sw.js not found — did the build run?");
  process.exit(1);
}

// Prefer the commit sha; fall back to a timestamp so a build from a
// tarball or a dirty tree still produces a unique, changing name.
let id;
try {
  id = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
  if (dirty) id += "-" + Date.now().toString(36);
} catch {
  id = Date.now().toString(36);
}

const src = fs.readFileSync(swPath, "utf8");
if (!src.includes("__BUILD_ID__")) {
  // Not fatal: a rebuilt tree may already be stamped. But say so, because
  // silently doing nothing is how the original bug persisted for months.
  console.warn("stamp-sw: no __BUILD_ID__ placeholder in build/sw.js — left unchanged");
  process.exit(0);
}
fs.writeFileSync(swPath, src.replace(/__BUILD_ID__/g, id));
console.log(`stamp-sw: cache name -> housify-${id}`);
