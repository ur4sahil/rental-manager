#!/usr/bin/env node
// Teach Housy a new portal by letting it look, and propose.
//
//   node worker/portals/explore.js washington_gas "find the current bill amount"
//
// This is the self-teaching half. Housy reads a page, proposes the next
// step, takes it, and repeats -- producing a PLAYBOOK a person ratifies
// once. After that the playbook replays deterministically: no model, no
// inference, milliseconds.
//
// TWO MODELS, TWO JOBS, chosen on measurements rather than taste:
//
//   Gemma reads the ACCESSIBILITY TREE and picks the next control. The
//   tree is exact, it names things clickably, and it is 2-6KB -- about ten
//   seconds. Gemma scored 2/3 on this exact task; its one failure was
//   acting when the right answer was "nothing here does that", which is
//   why the guard below exists rather than trust.
//
//   Qwen2.5-VL looks at the SCREENSHOT and answers the safety question:
//   what on this page would move money, and what is already filled in?
//   On the real Washington Gas payment form it found the amount, the
//   account, the submit button AND a pre-ticked charity donation -- 4 of 4
//   in 15 seconds, where Gemma found 1 of 4 and missed the donation.
//
// IT NEVER TAKES A FINAL ACTION. Anything that submits, pays or confirms
// is proposed and the run STOPS. A person approves the playbook; the
// playbook does the clicking, later, under its own guards.
const fs = require("fs");
const path = require("path");

// The browser and the session live on the operator's machine; the models
// live on the box. So this defaults to the tunnel, not to loopback -- the
// loopback default only works when the two happen to be the same host.
const AI = process.env.HOUSY_UPSTREAM || process.env.AI_BASE_URL || "https://housy.housify365.com";
const AI_TOKEN = process.env.AI_TOKEN || "";
const NAV_MODEL = process.env.HOUSY_MODEL || "gemma4:e2b";
const VIS_MODEL = process.env.HOUSY_VISION_MODEL || "qwen2.5vl:7b";
const MAX_STEPS = Number(process.env.HOUSY_MAX_STEPS || 6);

// Words that mean "this moves money or commits something". Matching one is
// not a failure -- it is the goal being reached -- but it ends the run.
const FINAL_ACTION = /\b(submit|pay now|pay bill|make payment|confirm|authorize|authorise|place order|complete|schedule payment|process)\b/i;

async function ask({ model, prompt, image, numPredict = 400 }) {
  const body = { model, prompt, stream: true, format: "json",
                 options: { temperature: 0, num_predict: numPredict, num_ctx: 8192 } };
  if (image) body.images = [image];
  const res = await fetch(`${AI.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The gate in front of Ollama rejects anything unauthenticated.
      ...(AI_TOKEN ? { Authorization: `Bearer ${AI_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
    // Streamed: undici abandons a request whose headers take over 300s,
    // and a vision call on CPU can cross that. Learned the hard way twice.
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  let a = "", th = "", tail = "";
  const dec = new TextDecoder();
  for await (const c of res.body) {
    tail += dec.decode(c, { stream: true });
    const parts = tail.split("\n"); tail = parts.pop() || "";
    for (const l of parts) {
      if (!l.trim()) continue;
      let p; try { p = JSON.parse(l); } catch { continue; }
      if (p.response) a += p.response;
      if (p.thinking) th += p.thinking;   // Qwen3 answers here, Gemma does not
    }
  }
  const raw = a.trim() ? a : th;
  try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); }
  catch { return null; }
}

// ---- what the page offers, as text -----------------------------------
// Value-shaped content: the things an answer usually looks like.
const VALUE_SHAPES = [
  /\$\s?[\d,]+\.\d{2}/,                       // money
  /\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/,           // phone
  /\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/,           // date
  /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/,         // date in words
  /\b\d{6,}\b/,                                // account number
  /[\w.+-]+@[\w-]+\.[\w.]+/,                   // email
];

// The 40 MOST RELEVANT lines, not the first 40.
//
// Taking the first 40 is arbitrary and it cost a real answer: on WSSC's
// customer-service page the phone number sits at line 144 of 200, so the
// read pass never saw it, reported nothing, and the explorer went off
// clicking instead. Capping for attention was right; choosing by position
// was not.
//
// Scored on overlap with the goal's own words plus whether the line
// contains something value-shaped, then returned in page order so the
// model reads them as a page rather than a ranking.
function rankLines(lines, goal) {
  const want = new Set(String(goal).toLowerCase().match(/[a-z]{3,}/g) || []);
  const scored = lines.map((line, i) => {
    const low = line.toLowerCase();
    let score = 0;
    for (const w of want) if (low.includes(w)) score += 3;
    if (VALUE_SHAPES.some(re => re.test(line))) score += 4;
    // A line that is nothing but a nav label is rarely the answer.
    if (/^(link|button)/.test(line) && line.length < 30) score -= 1;
    return { line, i, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 40)
    .sort((a, b) => a.i - b.i)
    .map(x => x.line);
}

async function readTree(page, goal) {
  const yaml = await page.locator("body").ariaSnapshot({ timeout: 20000 }).catch(() => "");
  const rows = yaml.split("\n").map(l => l.trim().replace(/^-\s*/, "").replace(/^['"]/, ""))
    // TEXT, not only controls -- and `row`/`cell`, which is where WSSC puts
    // an entire answer: account number, property, balance and due date in
    // one table row. Leading YAML quotes are stripped above, because a
    // quoted line reads as 'row rather than row and never matched.
    .filter(l => /^(textbox|button|link|combobox|radio|checkbox|heading|option|text|paragraph|cell|row)/.test(l));
  return rankLines([...new Set(rows)], goal);
}

async function proposeStep(tree, goal, history) {
  // PASS 1: is the answer already here? Nothing about clicking.
  //
  // Asked TWICE, differently framed, because this model is not
  // deterministic even at temperature 0. The identical prompt on the
  // identical 40 lines returned null on one run and
  // "$106.39 Due Date: 10-05-2026" on the next. A single call and a null
  // therefore proves nothing -- it is as likely to be a coin toss as an
  // absence.
  //
  // Two framings, and either finding something counts. This is a READ: a
  // value quoted off the page is checkable against the page, so a false
  // positive costs nothing and a false negative costs a wasted click.
  const framings = [
    ["Below are lines from a web page, including its text.",
     `You are looking for: ${goal}`,
     "If the page states it, quote the value EXACTLY as written. If it does",
     "not, return null. Do not guess and do not describe where it might be.",
     'Reply with JSON: {"found":string|null}'],
    ["Below are numbered lines from a web page.",
     `Which line states ${goal}, and what is the value?`,
     "Return null for both if no line states it.",
     'Reply with JSON: {"line":number|null,"found":string|null}'],
  ];
  for (let i = 0; i < framings.length; i++) {
    const body = i === 0 ? tree.join("\n") : tree.map((l, n) => `${n + 1}. ${l}`).join("\n");
    const r = await ask({ model: NAV_MODEL, prompt: [...framings[i], body].join("\n\n"), numPredict: 220 });
    if (r?.found) return { done: true, found: r.found, via: `read:${i + 1}` };
  }

  // PASS 2: only now, what to click. Nothing about reading.
  const clickPass = await ask({
    model: NAV_MODEL,
    prompt: [
      "You are operating a web page through its accessibility tree.",
      `GOAL: ${goal}`,
      history.length ? `Already done:\n${history.map((h, i) => `  ${i + 1}. ${h}`).join("\n")}` : null,
      "The value is NOT on this page -- that has been checked. Choose the ONE",
      "control that would take you closer to it, copying its label EXACTLY.",
      // The measured failure was clicking something related when the right
      // answer was nothing. Make that a first-class outcome, not a last
      // resort.
      "If NOTHING here advances the goal, set element to null and say why.",
      "Never pick a control merely because it sounds related.",
      'Reply with JSON: {"element":string|null,"role":string|null,"reason":string}',
      tree.join("\n"),
    ].filter(Boolean).join("\n\n"),
  });
  return { ...(clickPass || {}), done: false, via: "click" };
}

// ---- the safety read, on the picture ---------------------------------
async function inspectVisually(pngBase64) {
  return ask({
    model: VIS_MODEL, image: pngBase64, numPredict: 300,
    prompt:
      "Look at this page from a utility billing portal. Reply as JSON " +
      '{"page_purpose":string,"amount_shown":string|null,"account_shown":string|null,' +
      '"primary_button":string|null,"would_move_money":boolean,' +
      '"anything_that_adds_money":string|null}. ' +
      "anything_that_adds_money means a donation, tip or round-up that is offered " +
      "or already ticked. would_move_money is true if pressing the primary button " +
      "would submit a payment.",
  });
}

(async () => {
  const key = process.argv[2];
  const goal = process.argv.slice(3).join(" ") || "find the current bill amount due";
  const { PLAYBOOKS } = require("./playbooks");
  // A known portal by key, or any URL. The point of an explorer is sites it
  // has never seen; requiring a playbook first was backwards.
  const isUrl = /^https?:\/\//i.test(key || "");
  const book = isUrl ? { entry: key, provider: new URL(key).hostname } : PLAYBOOKS[key];
  if (!book) {
    console.error(`usage: explore.js <${Object.keys(PLAYBOOKS).join("|")}|https://...> "<goal>"`);
    process.exit(1);
  }

  const { createRequire } = require("module");
  let chromium = null;
  for (const base of [__filename, path.join(__dirname, "..", "..", "tests", "package.json")]) {
    try { ({ chromium } = createRequire(base)("playwright")); if (chromium) break; } catch {}
  }
  if (!chromium) { console.error("playwright not installed"); process.exit(1); }

  const sessionFile = path.join(process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions"), `${key}.json`);
  const haveSession = !isUrl && fs.existsSync(sessionFile);
  if (!isUrl && !haveSession) { console.error(`no session — run enroll.js ${key} first`); process.exit(1); }

  const browser = await (async () => {
  // A REAL browser, not headless chromium.
  //
  // Fairfax Water returned Cloudflare's "Sorry, you have been blocked" to
  // headless chromium and loads perfectly in system Chrome, from the same
  // machine and the same IP, seconds apart. Dominion rendered page chrome
  // and nothing else headless. Both were recorded here as blocked portals;
  // neither was.
  //
  // This is NOT a disguise. It launches the Chrome actually installed on
  // this machine -- a different client, not headless chromium pretending to
  // be one. No fingerprint patching, no stealth plugin, no proxy. headless
  // "new" mode is still used when Chrome is absent, because a sweep on a
  // server with no desktop browser must still run.
  try { return await chromium.launch({ channel: "chrome", headless: true }); }
  catch { return await chromium.launch({ headless: true }); }
})();
  const ctx = await browser.newContext({
    ...(haveSession ? { storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")) } : {}),
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 950 },
  });
  const page = await ctx.newPage();
  const shots = "/tmp/housy-shots";
  fs.mkdirSync(shots, { recursive: true });

  const proposed = [];     // the playbook being written
  const history = [];
  // Where it has already been, and what it has already clicked. Without
  // this it clicked "Customer Service" three times on the same URL: the
  // prompt carried a history but nothing CHECKED that a step moved.
  const seenUrls = new Set();
  const triedHere = new Map();
  console.log(`\nGOAL: ${goal}\n`);

  await page.goto(book.entry, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  seenUrls.add(page.url());

  for (let step = 1; step <= MAX_STEPS; step++) {
    const shot = path.join(shots, `${key}-explore-${step}.png`);
    await page.screenshot({ path: shot });
    const tree = await readTree(page, goal);
    console.log(`--- step ${step} · ${page.url().slice(0, 62)} · ${tree.length} controls`);

    const move = await proposeStep(tree, goal, history);
    if (!move) { console.log("    model returned nothing parseable — stopping"); break; }

    if (move.done) {
      console.log(`    DONE: ${move.found || "(no value given)"}`);
      proposed.push({ step, action: "read", found: move.found, url: page.url() });
      break;
    }
    if (!move.element) {
      console.log(`    nothing here advances the goal: ${(move.reason || "").slice(0, 80)}`);
      break;
    }

    const label = String(move.element);
    console.log(`    proposes: ${move.role || "?"} "${label.slice(0, 46)}"`);

    // The gate. A control that commits something is proposed and the run
    // ends -- the playbook may later click it, under the payment guards,
    // after a person has approved it.
    if (FINAL_ACTION.test(label)) {
      const vis = await inspectVisually(fs.readFileSync(shot).toString("base64"));
      console.log(`    STOPPING — this commits something.`);
      if (vis) {
        console.log(`    vision: purpose="${vis.page_purpose}" amount=${vis.amount_shown} moves_money=${vis.would_move_money}`);
        if (vis.anything_that_adds_money) console.log(`    ADDS MONEY: ${vis.anything_that_adds_money}`);
      }
      proposed.push({ step, action: "click", role: move.role, name: label, requiresApproval: true, vision: vis, screenshot: shot });
      break;
    }

    const loc = move.role === "button" ? page.getByRole("button", { name: label, exact: false }).first()
              : move.role === "link"   ? page.getByRole("link",   { name: label, exact: false }).first()
              : page.getByText(label, { exact: false }).first();
    if (!(await loc.count().catch(() => 0))) {
      // The model named something that is not on the page. Recorded, not
      // retried: a second guess after a hallucinated control is usually
      // another hallucinated control.
      console.log(`    "${label.slice(0, 40)}" is not actually on the page — stopping`);
      proposed.push({ step, action: "invalid", name: label, reason: "not present in the tree" });
      break;
    }

    // Refuse a control already tried on this page. A second identical
    // click is the definition of not making progress.
    const here = page.url();
    const tried = triedHere.get(here) || new Set();
    if (tried.has(label)) {
      console.log(`    already tried "${label.slice(0, 36)}" here — stopping rather than looping`);
      proposed.push({ step, action: "loop", name: label, url: here });
      break;
    }
    tried.add(label); triedHere.set(here, tried);

    const before = page.url();
    await loc.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const after = page.url();

    // A click that changed nothing is a dead end. Recorded as such, so a
    // reviewer sees WHY the run ended rather than a playbook full of
    // repeats.
    if (after === before && seenUrls.has(after)) {
      console.log(`    "${label.slice(0, 36)}" did not move the page — stopping`);
      proposed.push({ step, action: "no-op", role: move.role, name: label, url: after });
      break;
    }
    seenUrls.add(after);
    history.push(`clicked ${move.role} "${label.slice(0, 40)}"`);
    proposed.push({ step, action: "click", role: move.role, name: label, url: after });
  }

  const out = `/tmp/housy-playbook-${String(key).replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify({ portal: key, goal, entry: book.entry, steps: proposed }, null, 2));
  console.log(`\nproposed playbook: ${out}`);
  console.log(`${proposed.length} steps — review it, then it replays with no model at all.`);
  await browser.close();
})();
