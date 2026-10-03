// POST /api/finalize-signed-pdf?action=sign — the signing page's call to
// sign_document() (served by that route: Vercel's Hobby plan allows 12
// functions and api/ has 12),
// made from here instead of straight from the browser so the signer's
// real IP address goes on the record. The database's own
// inet_client_addr() only ever saw the API gateway (every signature read
// "::1", found 2026-10-03 on the certificate of completion); the web
// server sees the client's address in x-forwarded-for.
//
// Body: { token, signer_name, signature_data, signing_method, consent_text,
//         user_agent, e_records_consented, hw_sw_acknowledged, consent_version,
//         initials_data? }
// Response: whatever sign_document returns (200), or 4xx { error }.
// Same checks as the RPC itself: the token must be live; nothing here can
// sign for a token it was not given.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

/** The client's address as the edge saw it: the first x-forwarded-for entry. */
function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const cand = xf || String(req.headers["x-real-ip"] || "").trim() || (req.socket && req.socket.remoteAddress) || "";
  // Plain IPv4/IPv6 only; anything odd is dropped rather than stored.
  return /^[0-9a-fA-F:.]{3,45}$/.test(cand) ? cand.replace(/^::ffff:/, "") : null;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SVC) { res.status(500).json({ error: "Supabase env not configured" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const b = body || {};
  const token = String(b.token || "");
  if (token.length < 20 || token.length > 200) { res.status(400).json({ error: "invalid token" }); return; }
  if (!b.signature_data || String(b.signature_data).length > 400000) { res.status(400).json({ error: "signature required" }); return; }
  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  const ip = clientIp(req);
  try {
    if (b.initials_data) {
      const { data: ini, error: iniErr } = await sb.rpc("set_signature_initials", { p_token: token, p_initials_data: String(b.initials_data).slice(0, 200000) });
      if (iniErr) { res.status(400).json({ error: iniErr.message }); return; }
      if (ini && ini.error) { res.status(400).json({ error: ini.error }); return; }
    }
    const { data, error } = await sb.rpc("sign_document", {
      p_token: token,
      p_signer_name: String(b.signer_name || "").slice(0, 200),
      p_signature_data: String(b.signature_data),
      p_signing_method: String(b.signing_method || "").slice(0, 20),
      p_consent_text: String(b.consent_text || "").slice(0, 20000),
      p_user_agent: String(b.user_agent || req.headers["user-agent"] || "").slice(0, 500),
      p_e_records_consented: !!b.e_records_consented,
      p_hw_sw_acknowledged: !!b.hw_sw_acknowledged,
      p_consent_version: String(b.consent_version || "").slice(0, 40),
    });
    if (error) { res.status(400).json({ error: error.message }); return; }
    if (data && data.error) { res.status(400).json(data); return; }
    // The address, on the row the RPC just signed (the RPC's own
    // inet_client_addr() is the gateway). The signature hash does not
    // cover the IP, so setting it after is not a change to the record it
    // protects. Best effort: a missing address is not a failed signing.
    if (ip) {
      try { await sb.from("doc_signatures").update({ signer_ip: ip }).eq("access_token", token).eq("status", "signed"); }
      catch (e) { console.error("[sign-document] ip not recorded:", e.message); }
    }
    // The last signature finishes the envelope HERE, from the pages stored
    // when it was sent (api/_finalize-impl.js): stamped, filed and emailed
    // before this call returns, whatever the signer does with the tab. An
    // envelope sent before the body was stored gets no signed_pdf_path
    // back, and the page renders and uploads the PDF as before.
    if (data && data.all_signed && data.doc_id) {
      try {
        const { data: doc } = await sb.from("doc_generated").select("*").eq("id", data.doc_id).maybeSingle();
        if (doc && doc.envelope_status === "completed") {
          const { finalizeFromStoredBody } = require("./_finalize-impl");
          const out = await finalizeFromStoredBody(sb, req, doc);
          if (out) Object.assign(data, out, { server_finalized: true });
        }
      } catch (e) { console.error("[sign-document] server finalize failed:", e.message); }
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: "signing failed: " + String(e.message || e).slice(0, 200) });
  }
};
