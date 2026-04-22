import { supabase } from "../supabase";
import { pmError } from "./errors";

// ============ CREDENTIAL ENCRYPTION (server-side, per-credential salt) ============
// Encryption happens in /api/encrypt.js. The master key is a server-only
// Vercel secret (ENCRYPTION_KEY). Each credential row carries its own random
// 16-byte salt (encryption_salt column) so compromise of one plaintext does
// not trivially unlock every other credential in the company.
//
// Call-site contract:
//   encryptCredential(plain, companyId)
//     → { encrypted, iv, salt }  ← callers MUST persist all three
//   decryptCredential(cipher, iv, companyId, salt?)
//     → plaintext string; falls back to the legacy company-scoped salt
//       when a row has no salt column populated yet (pre-M15 rows).
//
// For Teller access-token rows created before M15, pass legacyScheme="teller"
// on the first decrypt — the row is re-written with a fresh salt afterwards
// by the save-enrollment path or the one-shot migration.

async function fetchEncrypt(token, body) {
  return fetch("/api/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(body),
  });
}

async function callEncryptApi(body) {
  let { data: { session } } = await supabase.auth.getSession();
  let token = session?.access_token;
  if (!token) throw new Error("No active session");
  let resp = await fetchEncrypt(token, body);
  // Long-running wizards (minutes between page load and Complete
  // Setup) can outlast the access-token lifetime. On 401 "Invalid
  // session" refresh the session once and retry — transparent
  // recovery instead of a confusing save-failed toast. Any other
  // non-ok response bubbles up as before.
  if (resp.status === 401) {
    try {
      const { data: refreshed } = await supabase.auth.refreshSession();
      token = refreshed?.session?.access_token;
    } catch (_e) { /* fall through to error below */ }
    if (token) resp = await fetchEncrypt(token, body);
  }
  if (!resp.ok) {
    let msg = "encrypt API " + resp.status;
    try { msg = (await resp.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return resp.json();
}

// Throws on real encrypt failure — callers must catch and abort the save
// rather than silently persisting an empty ciphertext (which earlier
// builds did by returning { encrypted: "", iv: "", salt: "" }). Empty
// plaintext is still a valid no-op and returns the empty triple.
export async function encryptCredential(plaintext, companyId, reuseSalt = null) {
  if (!plaintext) return { encrypted: "", iv: "", salt: reuseSalt || "" };
  // reuseSalt lets two paired values (e.g. username + password) share a
  // per-row salt while each still gets its own IV. Persist the salt once
  // on the row; reuse it on the second encrypt so decrypt with the row's
  // encryption_salt succeeds for both values.
  const body = { action: "encrypt", plaintext, companyId };
  if (reuseSalt) body.salt = reuseSalt;
  try {
    return await callEncryptApi(body);
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "encryptCredential — throwing so caller aborts save" });
    throw new Error("Encryption failed: " + (e.message || e));
  }
}

// Returns null on decrypt failure rather than a sentinel placeholder.
// Previous version returned "••••••" which some callers rendered
// straight into an <input value>, persisting the literal dots on save
// and wiping the real stored credential. Callers that want a display
// placeholder should coalesce: `(await decryptCredential(...)) || "—"`.
export async function decryptCredential(encryptedB64, ivHex, companyId, salt = null, legacyScheme = null) {
  if (!encryptedB64 || !ivHex) return null;
  try {
    const body = { action: "decrypt", ciphertext: encryptedB64, iv: ivHex, companyId };
    if (salt) body.salt = salt;
    if (legacyScheme) body.legacyScheme = legacyScheme;
    const { plaintext } = await callEncryptApi(body);
    return plaintext || "";
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "decryptCredential", silent: true });
    return null;
  }
}
