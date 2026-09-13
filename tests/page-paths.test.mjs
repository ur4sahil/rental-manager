// Every page must have a URL.
//
// Real paths replaced hash routing, which means a page id now needs an
// entry in PAGE_PATHS as well as a component. Adding Housy proved the
// gap: it was registered in pageComponents and the nav, the routes test
// passed, and /housy silently rendered the DASHBOARD -- because
// pageForPath() found no match and fell back.
//
// A page that cannot be addressed does not exist, and nothing was
// checking for it.
import fs from "fs";
import path from "path";

const ROOT = path.join(import.meta.dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "src/App.js"), "utf8");
const routes = fs.readFileSync(path.join(ROOT, "src/utils/routes.js"), "utf8");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

// page ids, from the component map
const block = app.match(/pageComponents\s*=\s*\{([\s\S]*?)\n\s*\};/);
if (!block) throw new Error("pageComponents not found in App.js");
const pageIds = [...block[1].matchAll(/^\s*([a-z_0-9]+)\s*:/gm)].map(m => m[1]);

// paths, from the route map
const pathBlock = routes.match(/PAGE_PATHS\s*=\s*\{([\s\S]*?)\n\};/);
if (!pathBlock) throw new Error("PAGE_PATHS not found in routes.js");
const paths = Object.fromEntries(
  [...pathBlock[1].matchAll(/([a-z_0-9]+)\s*:\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));

check("pageComponents has entries", pageIds.length > 20, `${pageIds.length}`);
const missing = pageIds.filter(id => !paths[id]);
check("every page id has a URL", missing.length === 0,
  `no path for: ${missing.join(", ")} — these render the dashboard instead of themselves`);

const orphan = Object.keys(paths).filter(id => !pageIds.includes(id));
check("every path points at a real page", orphan.length === 0,
  `path with no component: ${orphan.join(", ")}`);

// Two pages sharing a URL means one of them is unreachable.
const byPath = {};
for (const [id, p] of Object.entries(paths)) (byPath[p] = byPath[p] || []).push(id);
const dupes = Object.entries(byPath).filter(([, ids]) => ids.length > 1);
check("no two pages share a URL", dupes.length === 0,
  dupes.map(([p, ids]) => `${p}: ${ids.join(" + ")}`).join("; "));

for (const [id, p] of Object.entries(paths)) {
  if (!p.startsWith("/")) { check(`${id} path is absolute`, false, p); }
}
check("all paths are absolute", Object.values(paths).every(p => p.startsWith("/")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
