import { supabase } from "../supabase";
import { pmError } from "./errors";

// ============ CREDENTIAL ENCRYPTION (server-side) ============
// Encryption now happens in /api/encrypt.js with the master key held as
// a server-only Vercel secret (ENCRYPTION_KEY). The previous version
// used REACT_APP_ENCRYPTION_KEY which shipped to every browser in the
// bundle — defeating the point of encrypting at rest. Function
// signatures are identical so callers don't need to change.
//
// Migration note: rows already encrypted with the old client-side key
// decrypt correctly as long as ENCRYPTION_KEY is set to the same value
// REACT_APP_ENCRYPTION_KEY held. Once rotated, a one-time re-encrypt
// migration is required (future task).

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

export async function encryptCredential(plaintext, companyId) {
  if (!plaintext) return { encrypted: "", iv: "" };
  try {
    return await callEncryptApi({ action: "encrypt", plaintext, companyId });
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "encryptCredential", silent: true });
    return { encrypted: "", iv: "" };
  }
}

export async function decryptCredential(encryptedB64, ivHex, companyId) {
  if (!encryptedB64 || !ivHex) return "";
  try {
    const { plaintext } = await callEncryptApi({ action: "decrypt", ciphertext: encryptedB64, iv: ivHex, companyId });
    return plaintext || "";
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "decryptCredential", silent: true });
    return "••••••";
  }
}
