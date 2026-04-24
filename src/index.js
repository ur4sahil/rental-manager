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
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // silent — dev Safari and private windows can block SW
    });
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
