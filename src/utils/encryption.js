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

async function callEncryptApi(body) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("No active session");
  const resp = await fetch("/api/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = "encrypt API " + resp.status;
    try { msg = (await resp.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return resp.json();
}

export async function encryptCredential(plaintext, companyId, reuseSalt = null) {
  if (!plaintext) return { encrypted: "", iv: "", salt: reuseSalt || "" };
  try {
    // reuseSalt lets two paired values (e.g. username + password) share a
    // per-row salt while each still gets its own IV. Persist the salt once
    // on the row; reuse it on the second encrypt so decrypt with the row's
    // encryption_salt succeeds for both values.
    const body = { action: "encrypt", plaintext, companyId };
    if (reuseSalt) body.salt = reuseSalt;
    return await callEncryptApi(body);
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "encryptCredential", silent: true });
    return { encrypted: "", iv: "", salt: reuseSalt || "" };
  }
}

export async function decryptCredential(encryptedB64, ivHex, companyId, salt = null, legacyScheme = null) {
  if (!encryptedB64 || !ivHex) return "";
  try {
    const body = { action: "decrypt", ciphertext: encryptedB64, iv: ivHex, companyId };
    if (salt) body.salt = salt;
    if (legacyScheme) body.legacyScheme = legacyScheme;
    const { plaintext } = await callEncryptApi(body);
    return plaintext || "";
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "decryptCredential", silent: true });
    return "••••••";
  }
}
