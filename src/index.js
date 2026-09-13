import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Register the PWA service worker on boot. Previously this only ran
// inside registerPushNotifications(), which is gated behind a VAPID
// key — so the service worker was never registered unless push was
// configured, and the app-shell cache / install-to-home-screen didn't
// work. Registering here makes the PWA installable and enables the
// offline shell; push registration still happens separately when the
// user opts in.
if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      if (!reg) return;

      // Ask whether a new version exists. A browser only checks for a new
      // service worker on navigation or roughly daily, and an installed PWA
      // may go days without either -- so a deploy can sit unseen while the
      // app keeps serving the bundle it started with. That is exactly what
      // happened with the Housy AI rename: it was live on the server and
      // still read "Housy" on the phone.
      const poll = () => reg.update().catch(() => {});
      setInterval(poll, 60 * 60 * 1000);
      // And whenever the app comes back to the foreground, which is the
      // moment someone is about to look at it.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") poll();
      });
    }).catch(() => {
      // silent — dev Safari and private windows can block SW
    });
  });

  // sw.js calls skipWaiting() and clients.claim(), so a new worker takes
  // control of this page the moment it installs. But taking control does
  // NOT reload the page: the old JavaScript keeps running until the app is
  // fully closed. Reload once when control changes, so a deploy actually
  // reaches the person looking at it.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // On a FIRST install there was no previous controller and nothing is
    // stale; reloading then would refresh every new visitor for no reason.
    if (reloading || !navigator.serviceWorker.controller) return;
    reloading = true;
    window.location.reload();
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
