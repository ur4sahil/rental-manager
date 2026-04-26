// Housify service worker — PWA + push.
// Strategy:
//   • install: pre-cache the app shell (index + fallback page).
//   • activate: drop old caches so we never serve stale JS/CSS bundles
//     after a deploy. CACHE_NAME bumps per deploy via the build step
//     or manual increment.
//   • fetch:
//       - navigation requests -> network first, fall back to the cached
//         index.html so offline opens still render the app shell.
//       - static assets (/static/, images, fonts) -> cache first, then
//         network. Hashed asset URLs are immutable, so cache-forever is
//         correct.
//       - everything else (API, Supabase, Teller) -> network only,
//         never cached. Financial/auth data must stay fresh.
//   • push + notificationclick: unchanged from v1.

const CACHE_NAME = "housify-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo192.png",
  "/logo512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Only handle same-origin. Let cross-origin (Supabase, Teller, Stripe,
  // Google Fonts) go straight to the network without caching.
  if (url.origin !== self.location.origin) return;

  // Navigation: try network, fall back to cached index.html so the app
  // shell still renders offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Static assets: cache-first. CRA emits hashed filenames under
  // /static/, so caches never go stale for a given URL.
  if (url.pathname.startsWith("/static/") ||
      /\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  // Everything else: network only — no caching of dynamic data.
});

self.addEventListener("push", (event) => {
  // Diagnostic-instrumented push handler. Beacons every step back to
  // /api/notifications?action=beacon so we can see SW-side delivery
  // and showNotification outcomes in push_attempts. iOS PWA push is
  // notoriously hard to debug otherwise.
  async function beacon(payload_tag, status, error_message, meta) {
    try {
      await fetch("/api/notifications?action=beacon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload_tag, status, error_message, ...(meta || {}) }),
      });
    } catch (_e) { /* network failed — no recovery, just continue */ }
  }

  async function handle() {
    let data = {};
    let payloadTag = null;
    try {
      data = event.data ? event.data.json() : {};
      payloadTag = data.payload_tag || null;
    } catch (e) {
      await beacon(null, "sw_parse_error", String(e?.message || e));
      return;
    }
    await beacon(payloadTag, "sw_received", null, {
      title: data.title || null,
      body: data.message || null,
      recipient_email: data.recipient_email || null,
      company_id: data.company_id || null,
    });
    const tag = data.tag || ("housify-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    const options = {
      body: data.message || "New notification from Housify",
      icon: "/logo192.png",
      badge: "/logo192.png",
      tag,
      renotify: true,
      data: { url: data.url || "/" },
      actions: data.actions || [],
    };
    try {
      await self.registration.showNotification(data.title || "Housify", options);
      await beacon(payloadTag, "sw_displayed", null);
    } catch (e) {
      await beacon(payloadTag, "sw_show_error", String(e?.message || e));
    }
  }
  event.waitUntil(handle());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || "/")
  );
});
