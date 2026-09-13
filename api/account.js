// Account lifecycle: one dispatcher over what used to be two routes.
//
//   POST /api/account?action=cleanup-orphan-signup
//   POST /api/account?action=self-delete
//
// Merged because Vercel caps this project at 12 serverless functions and
// api/ had reached 13 when the AI route arrived. These two were the safe
// pair: four call sites, all in our own code, and neither URL is
// registered with an outside service the way the Plaid webhook is.
//
// The handlers themselves are unchanged -- they moved to _*-impl.js and
// are called here, so this merge is a routing change and nothing else.
const cleanupOrphanSignup = require("./_cleanup-orphan-signup-impl");
const selfDeleteAccount = require("./_self-delete-account-impl");

module.exports = async function handler(req, res) {
  const action = String(req.query?.action || "");
  if (action === "cleanup-orphan-signup") return cleanupOrphanSignup(req, res);
  if (action === "self-delete") return selfDeleteAccount(req, res);
  return res.status(400).json({ error: `unknown action "${action}"` });
};
