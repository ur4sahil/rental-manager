// Native-bridge helpers. Everything here is runtime-safe in the browser —
// Capacitor's platform check returns "web" when there's no native host,
// and the thin wrappers fall back to browser equivalents. Import from
// one place so we can swap implementations per platform without touching
// call sites.

import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Share } from "@capacitor/share";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { StatusBar, Style } from "@capacitor/status-bar";

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform(); // "ios" | "android" | "web"

// Open an external URL. On native iOS this uses SFSafariViewController
// (in-app browser with a Done button); on web it falls back to window.open.
export async function openExternal(url) {
  if (!url) return;
  if (isNative()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

// Save a file locally and present the system share sheet. On web this
// triggers the browser download. Use for CSV/XLSX/PDF exports.
export async function saveAndShareFile({ filename, data, mimeType = "application/octet-stream" }) {
  if (isNative()) {
    // Capacitor Filesystem writes base64 to the app's Documents dir, then
    // Share surfaces a share sheet pointing at the file.
    const base64 = typeof data === "string" ? data : await blobToBase64(data);
    const res = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache,
    });
    await Share.share({
      title: filename,
      url: res.uri,
      dialogTitle: "Share file",
    });
    return;
  }
  // Web path: browser download via a temporary anchor
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      // strip "data:<mime>;base64,"
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Call once on app boot to set the status bar style to match our brand.
export async function initStatusBar() {
  if (!isNative()) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
  } catch (_e) { /* older iOS, ignore */ }
}
