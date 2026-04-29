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

const CACHE_NAME = "housify-v4";
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
  // CRITICAL iOS contract: every push event MUST call showNotification
  // before this handler completes, on EVERY code path. Apple's docs:
  // "Safari doesn't support invisible push notifications. … If you
  // don't, Safari revokes the push notification permission for your
  // site." Community-reported threshold: 3 silent pushes → permission
  // revoked → APNS keeps returning 201 forever but no banner appears.
  // This is the root cause of "works for one day, then breaks." Every
  // try/catch here ends in showNotification, even if all we have is
  // a generic fallback.
  //
  // Beacons stay (diagnostics) but are best-effort and never gate
  // showNotification.
  async function beacon(payload_tag, status, error_message, meta) {
    try {
      await fetch("/api/notifications?action=beacon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload_tag, status, error_message, ...(meta || {}) }),
      });
    } catch (_e) { /* swallow */ }
  }

  async function showSafely(title, opts, payloadTag, label) {
    try {
      await self.registration.showNotification(title, opts);
      beacon(payloadTag, "sw_displayed_" + label, null);
    } catch (e) {
      // Last-resort fallback: bare-bones notification with no options.
      // If even this throws, we've done our best — at least we tried.
      try {
        await self.registration.showNotification("Housify", { body: "New activity" });
        beacon(payloadTag, "sw_displayed_fallback_" + label, null);
      } catch (e2) {
        beacon(payloadTag, "sw_show_error_" + label, String(e?.message || e) + " | fallback: " + String(e2?.message || e2));
      }
    }
  }

  async function handle() {
    let data = {};
    let payloadTag = null;
    let parseErrorMsg = null;
    try {
      data = event.data ? event.data.json() : {};
      payloadTag = data.payload_tag || null;
    } catch (e) {
      parseErrorMsg = String(e?.message || e);
    }
    if (parseErrorMsg) {
      // Even on parse error, show SOMETHING so iOS doesn't count this
      // as a silent push and revoke our permission.
      beacon(null, "sw_parse_error", parseErrorMsg);
      await showSafely("Housify", { body: "New activity", icon: "/logo192.png", badge: "/logo192.png" }, null, "parse_error");
      return;
    }
    beacon(payloadTag, "sw_received", null, {
      title: data.title || null,
      body: data.message || null,
      recipient_email: data.recipient_email || null,
      company_id: data.company_id || null,
    });
    const tag = data.tag || ("housify-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    const options = {
      body: data.message || "New activity",
      icon: "/logo192.png",
      badge: "/logo192.png",
      tag,
      renotify: true,
      data: { url: data.url || "/" },
      actions: data.actions || [],
    };
    await showSafely(data.title || "Housify", options, payloadTag, "main");
  }
  event.waitUntil(handle());
});

// pushsubscriptionchange — IDL exists on iOS but does not currently
// fire (confirmed by WebKit engineer Ben Nham, Bugzilla 273063, May
// 2024). Listen anyway: harmless on iOS today, automatic recovery on
// other browsers, and future-proof for when Apple wires it up.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      await fetch("/api/notifications?action=beacon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "sw_subscription_change", error_message: null }),
      });
    } catch (_e) { /* swallow */ }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || "/")
  );
});
