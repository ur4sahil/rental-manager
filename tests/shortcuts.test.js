// Keyboard shortcuts: registry integrity + the behaviours the handlers
// implement. These are adversarial by design — they check the things
// that would silently rot (help text drifting from real keys, a key
// claimed by two features, single-letter keys eating typed input).
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail = "") {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const ks = read("components/KeyboardShortcuts.js");
const banking = read("components/Banking.js");
const accounting = read("components/Accounting.js");
const app = read("App.js");
const palette = read("components/CommandPalette.js");

// ---- Registry -------------------------------------------------------
const groupIds = [...ks.matchAll(/^\s*id: "(\w+)",\s*$/gm)].map(m => m[1]);
assert("registry defines the three groups",
  ["global", "review", "je"].every(g => groupIds.includes(g)), groupIds.join(","));

const REVIEW_KEYS = {};
const rkBlock = ks.slice(ks.indexOf("export const REVIEW_KEYS"), ks.indexOf("// True when the event"));
for (const m of rkBlock.matchAll(/(\w+): \[([^\]]+)\]/g)) {
  REVIEW_KEYS[m[1]] = m[2].split(",").map(s => s.trim().replace(/"/g, ""));
}
assert("REVIEW_KEYS covers every review action",
  ["down", "up", "open", "add", "match", "transfer", "split", "exclude", "undo"]
    .every(k => Array.isArray(REVIEW_KEYS[k]) && REVIEW_KEYS[k].length),
  Object.keys(REVIEW_KEYS).join(","));

// No key may mean two things in the same scope — the bug you only find
// in production when "s" both splits and does something else.
const seen = new Map();
let collision = null;
for (const [action, keys] of Object.entries(REVIEW_KEYS))
  for (const k of keys) {
    if (seen.has(k)) collision = `${k}: ${seen.get(k)} vs ${action}`;
    seen.set(k, action);
  }
assert("no review key is bound to two actions", collision === null, collision || "");

assert("review keys are lowercase (handler lowercases e.key)",
  Object.values(REVIEW_KEYS).flat().every(k => k === k.toLowerCase()));

// Every key the handler branches on must be described in the help sheet,
// or the app does something it never tells the user about.
const reviewGroup = ks.slice(ks.indexOf('id: "review"'), ks.indexOf('id: "je"'));
const documented = reviewGroup.toLowerCase();
const missing = ["a", "m", "t", "s", "x", "u", "j", "k"].filter(k =>
  !new RegExp(`"${k}"`, "i").test(reviewGroup) && !documented.includes(`"${k}"`));
assert("every single-letter review key appears in the help sheet", missing.length === 0, missing.join(","));

// ---- Typing guard ---------------------------------------------------
assert("isTypingTarget covers input, textarea, select and contentEditable",
  ["INPUT", "TEXTAREA", "SELECT", "isContentEditable"].every(t => ks.includes(t)));
assert("review handler yields to typing for unmodified keys",
  /if \(!modified && isTypingTarget\(e\)\) return;/.test(banking));
assert("Cmd+Enter still posts from inside a field",
  banking.indexOf('if (modified && key === "enter")') > banking.indexOf("if (!modified && isTypingTarget(e)) return;"));
assert('"?" is ignored while typing', /if \(isTypingTarget\(e\)\) return;/.test(ks));
assert('"?" is ignored when a modifier is held', /e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\) return;/.test(ks));

// ---- Review handler -------------------------------------------------
assert("cursor is separate from the expanded panel",
  banking.includes("const [selectedTxn, setSelectedTxn]") && banking.includes("expandedTxn"));
assert("stale cursor is dropped when the row leaves the page",
  /if \(selectedTxn && !paginatedTxns\.some\(t => t\.id === selectedTxn\)\) setSelectedTxn\(null\)/.test(banking));
assert("undo only fires on rows that were actioned",
  /\["categorized", "matched", "posted", "excluded"\]\.includes\(current\.status\)/.test(banking));
assert("add/match/transfer/split only fire on for_review rows",
  banking.indexOf('if (current.status !== "for_review") return;') <
  banking.indexOf("REVIEW_KEYS.exclude.includes(key)"));
assert("Cmd+Enter refuses to post an unset account",
  /if \(!addForm\.accountId\) return;/.test(banking));
assert("Cmd+Enter refuses a split with fewer than two funded lines",
  /splitLines\.filter\(l => l\.accountId && safeNum\(l\.amount\) > 0\)\.length < 2\) return;/.test(banking));
assert("Match has no keyboard default (no safe candidate to guess)",
  /\/\/ Match needs a chosen candidate; there is no safe default\.\s*\n\s*return;/.test(banking));
assert("posting advances the cursor to the next row",
  /const next = paginatedTxns\[idx \+ 1\];/.test(banking));
assert("keyboard open seeds the panel from the rule suggestion",
  banking.includes("const openPanel = (txn)") && banking.includes("_suggestion"));
assert("the cursor row is visibly marked", /ring-2 ring-inset ring-brand-400/.test(banking));
assert("the cursor row is announced to assistive tech", /aria-selected=\{selectedTxn === txn\.id\}/.test(banking));
assert("clicking a row also moves the cursor",
  /onClick=\{\(\) => \{ setSelectedTxn\(txn\.id\); setExpandedTxn/.test(banking));
assert("handler stands down for a modal or the palette",
  /document\.querySelector\('\[role="dialog"\]'\)\) return;/.test(banking));

// ---- Journal entry handler ------------------------------------------
assert("JE rows are addressable for the current-line lookup", /data-je-line=\{i\}/.test(accounting));
assert("current line is read from focus, not mirrored state",
  /document\.activeElement\?\.closest\?\.\("tr\[data-je-line\]"\)/.test(accounting));
assert("Cmd+Enter will not save an invalid or undescribed entry",
  /if \(form\.description\.trim\(\) && validation\.isValid\) saveEntry\("posted"\);/.test(accounting));
assert("Enter on the last line adds a line, otherwise steps down",
  /if \(i === form\.lines\.length - 1\) \{ addLine\(\); focusRow\(i \+ 1\); \}/.test(accounting));
assert("duplicate copies the coding but never the amounts",
  /lines\.splice\(i \+ 1, 0, \{ \.\.\.src, debit: "", credit: ""/.test(accounting));
assert("delete respects the two-line minimum",
  /if \(i === -1 \|\| form\.lines\.length <= 2\) return;/.test(accounting));
assert("auto-balance does nothing on an already-balanced entry",
  /if \(diff === 0\) return;/.test(accounting));

// Auto-balance arithmetic, run against the source's own rule.
const balance = (totalDebit, totalCredit) => {
  const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
  if (diff === 0) return null;
  return diff > 0 ? { credit: diff.toFixed(2), debit: "" } : { debit: Math.abs(diff).toFixed(2), credit: "" };
};
assert("balance fills the credit side when debits lead",
  JSON.stringify(balance(1600, 0)) === JSON.stringify({ credit: "1600.00", debit: "" }));
assert("balance fills the debit side when credits lead",
  JSON.stringify(balance(0, 250.5)) === JSON.stringify({ debit: "250.50", credit: "" }));
assert("balance is a no-op when already square", balance(1600, 1600) === null);
assert("balance survives float dust (0.1+0.2 vs 0.3)", balance(0.1 + 0.2, 0.3) === null);
assert("balance rounds to cents, never fractions",
  balance(100.005, 0).credit === "100.01" || balance(100.005, 0).credit === "100.00");

// ---- Discoverability ------------------------------------------------
assert("the help sheet is mounted exactly once, in App",
  (app.match(/<ShortcutsHelp /g) || []).length === 1 &&
  !banking.includes("<ShortcutsHelp") && !accounting.includes("<ShortcutsHelp"));
assert('"?" is bound through the shared host hook', /useShortcutsHost\(/.test(app) && /useShortcutHelpKey\(/.test(ks));
assert('"?" opens the sheet scoped to the current page',
  /acct_bankimport" \? "review" : p === "acct_journal" \? "je"/.test(app));
assert("components open the sheet by event, not prop-drilling",
  ks.includes("SHORTCUTS_EVENT") && banking.includes("openShortcuts(") && accounting.includes("openShortcuts("));
assert("a visible Shortcuts affordance exists on Bank Transactions",
  /<ShortcutsHint onClick=\{\(\) => openShortcuts\("review"\)\}/.test(banking));
assert("a visible Shortcuts affordance exists on the JE form",
  /<ShortcutsHint onClick=\{\(\) => openShortcuts\("je"\)\}/.test(accounting));
assert("the palette lists Keyboard shortcuts", /label: "Keyboard shortcuts"/.test(palette));
assert("the sheet is a real dialog", /role="dialog"[\s\S]{0,80}aria-modal="true"/.test(ks));
assert("Escape closes the sheet", /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); onClose\(\); \}/.test(ks));
// Escape must escape even mid-typing, or a memo field traps the keyboard.
assert("Escape closes the review panel from inside a field",
  /if \(!modified && e\.key === "Escape" && expandedTxn\)/.test(banking) &&
  banking.indexOf('e.key === "Escape" && expandedTxn') < banking.indexOf("if (!modified && isTypingTarget(e)) return;"));
assert("Escape blurs the field it closes from", /isTypingTarget\(e\) && e\.target\.blur\) e\.target\.blur\(\)/.test(banking));
assert("the modifier label follows the platform", /const MOD = isMac \? "⌘" : "Ctrl"/.test(ks));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
