import { pmError } from "./errors";

// ============ CREDENTIAL ENCRYPTION (AES-256-GCM via Web Crypto + PBKDF2) ============
// Master key from environment — required for credential encryption
const _MASTER_KEY = process.env.REACT_APP_ENCRYPTION_KEY || "";
async function _deriveKey(companyId, usage) {
  if (!_MASTER_KEY) throw new Error("REACT_APP_ENCRYPTION_KEY not configured — credential encryption unavailable");
  const salt = new TextEncoder().encode("propmanager_" + companyId + "_v2");
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(_MASTER_KEY), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, usage);
}
export async function encryptCredential(plaintext, companyId) {
  if (!plaintext) return { encrypted: "", iv: "" };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _deriveKey(companyId, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  return { encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))), iv: ivHex };
}
export async function decryptCredential(encryptedB64, ivHex, companyId) {
  if (!encryptedB64 || !ivHex) return "";
  try {
    const key = await _deriveKey(companyId, ["decrypt"]);
    const hexParts = ivHex.match(/.{2}/g);
    if (!hexParts) return "••••••";
    const iv = new Uint8Array(hexParts.map(h => parseInt(h, 16)));
    const ciphertext = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch (e) { pmError("PM-8006", { raw: e, context: "credential decryption", silent: true }); return "���•••••"; }
}
