// ════════════════════════════════════════════════════════════════════
// Notifications dispatcher — consolidates two former routes into one
// Vercel function so we stay under the Hobby-plan 12-function cap.
//
// Was previously:
//   /api/send-push           → web-push delivery
//   /api/notification-worker → Resend email worker (drains the queue)
//
// Now both behaviors live in /api/notifications behind ?action=:
//   ?action=push    → fan out a push notification to all of a user's
//                     registered devices. JWT-authed; caller must be
//                     an active member of the target company.
//   ?action=worker  → drain notification_queue rows, send via Resend.
//                     Bearer CRON_SECRET (cron path) OR a regular user
//                     JWT (in-app fire-on-insert path) accepted.
//
// Implementations live in /api/_send-push-impl.js and
// /api/_notification-worker-impl.js. Files prefixed with `_` are not
// counted by Vercel as serverless functions, so the impl modules
// don't burn slots. Same pattern as daily-reminders.js +
// _license-expiry-reminders-impl.js + _tax-bill-reminders-impl.js.
// ════════════════════════════════════════════════════════════════════
const sendPushImpl = require("./_send-push-impl");
const notificationWorkerImpl = require("./_notification-worker-impl");
const { setCors } = require("./_cors");

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const action = (req.query?.action || "").toString();
  if (action === "push") return sendPushImpl(req, res);
  if (action === "worker") return notificationWorkerImpl(req, res);
  return res.status(404).json({
    error: "unknown action — try ?action=push or ?action=worker",
  });
};
