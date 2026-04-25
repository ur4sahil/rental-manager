// Vercel API Route: combined daily-reminders dispatcher.
//
// Two distinct reminder scans were originally one Vercel function
// each — tax-bill-reminders and license-expiry-reminders — but the
// Hobby plan caps total functions at 12, and adding the email-
// delivery worker hit that ceiling. Consolidating them here behind
// a `?task=` query param keeps both schedules running while
// freeing a slot.
//
// Cron entries in vercel.json call:
//   /api/daily-reminders?task=licenses   at 13:00 UTC
//   /api/daily-reminders?task=tax-bills  at 14:00 UTC
//
// The two implementation files are renamed to _-prefixed names so
// Vercel doesn't treat them as separate routes — they're internal
// modules required by this dispatcher.

const taxHandler = require("./_tax-bill-reminders-impl");
const licenseHandler = require("./_license-expiry-reminders-impl");
const { setCors } = require("./_cors");

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const task = (req.query && req.query.task)
    || (req.body && typeof req.body === "object" && req.body.task)
    || "";
  if (task === "tax-bills") return taxHandler(req, res);
  if (task === "licenses") return licenseHandler(req, res);
  // Allow running both back-to-back when invoked with ?task=all (or no task)
  if (task === "all" || !task) {
    // Each handler responds independently — when chaining we have to
    // collect their outputs. Spy on res to capture each result, then
    // emit one combined response.
    const results = {};
    for (const [k, h] of [["licenses", licenseHandler], ["tax-bills", taxHandler]]) {
      results[k] = await new Promise((resolve) => {
        const fakeRes = {
          status(code) { this._code = code; return this; },
          json(payload) { resolve({ http: this._code || 200, body: payload }); },
          end() { resolve({ http: this._code || 200 }); },
          setHeader() {},
        };
        try { Promise.resolve(h(req, fakeRes)).catch(e => resolve({ http: 500, error: e.message })); }
        catch (e) { resolve({ http: 500, error: e.message }); }
      });
    }
    res.status(200).json({ ok: true, results });
    return;
  }
  res.status(400).json({ error: 'unknown task; expected ?task=licenses|tax-bills|all' });
};
