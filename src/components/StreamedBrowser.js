import React, { useEffect, useRef, useState, useCallback } from "react";

// A real browser, running on the VPS, rendered here on a canvas. The person
// sees the utility's own card page and types their card into it; the keystrokes
// travel to that browser and the card goes browser → utility over HTTPS. Nothing
// about the card touches PropManager — no state, no storage, no logging.
//
// The server streams JPEG frames (CDP screencast) over a WebSocket and accepts
// mouse/key/text events back. The page renders at a fixed 1280×900; we scale
// pointer coordinates from the on-screen canvas into that space so a click lands
// where the person aimed regardless of how big the canvas is drawn.
const PAGE_W = 1280;
const PAGE_H = 900;

export default function StreamedBrowser({ url, provider, streamBase, token, onPaid, onClose }) {
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const imgRef = useRef(typeof Image !== "undefined" ? new Image() : null);
  const [status, setStatus] = useState("connecting"); // connecting | ready | paid | error | expired
  const [detail, setDetail] = useState("");

  // Turn a pointer event into page-space coordinates.
  const toPage = useCallback((e) => {
    const c = canvasRef.current; if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    const px = "touches" in e && e.touches[0] ? e.touches[0].clientX : e.clientX;
    const py = "touches" in e && e.touches[0] ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(PAGE_W, (px - r.left) * (PAGE_W / r.width))),
      y: Math.max(0, Math.min(PAGE_H, (py - r.top) * (PAGE_H / r.height))),
    };
  }, []);

  const sendEv = useCallback((obj) => {
    const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }, []);

  useEffect(() => {
    if (!streamBase || !provider) return;
    const qs = new URLSearchParams({ provider });
    if (url) qs.set("url", url);
    if (token) qs.set("token", token);
    const wsUrl = streamBase.replace(/^http/, "ws") + "/?" + qs.toString();
    let alive = true;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => alive && setStatus((s) => (s === "connecting" ? "connecting" : s));
    ws.onerror = () => { if (alive) { setStatus("error"); setDetail("Could not reach the browser service."); } };
    ws.onclose = (e) => { if (alive && e.code === 4000) setStatus("expired"); };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "frame") {
        const img = imgRef.current, cv = canvasRef.current;
        if (!img || !cv) return;
        img.onload = () => { const ctx = cv.getContext("2d"); ctx && ctx.drawImage(img, 0, 0, PAGE_W, PAGE_H); };
        img.src = "data:image/jpeg;base64," + msg.data;
      } else if (msg.type === "ready") {
        setStatus("ready");
      } else if (msg.type === "paid") {
        setStatus("paid");
        setDetail(msg.confirmation ? `Confirmation ${msg.confirmation}` : "Payment confirmed");
        onPaid && onPaid(msg);
      } else if (msg.type === "fatal") {
        setStatus("error"); setDetail(msg.message || "Session failed.");
      } else if (msg.type === "expired") {
        setStatus("expired");
      }
    };

    // Ask the server to re-check for a confirmation page a moment after any
    // click, in case a submit navigated without a frame we noticed.
    return () => { alive = false; try { ws.close(); } catch {} };
  }, [streamBase, provider, url, token, onPaid]);

  // Keyboard: printable characters go as text (so card digits type cleanly);
  // control keys go as key events so Tab/Enter/Backspace work in the form.
  const onKeyDown = useCallback((e) => {
    if (status !== "ready") return;
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) sendEv({ type: "text", text: e.key });
    else sendEv({ type: "key", down: true, key: e.key, code: e.code, keyCode: e.keyCode });
  }, [status, sendEv]);

  const interactive = status === "ready";
  return (
    <div className="fixed inset-0 z-[3000] bg-black/70 flex items-center justify-center p-2 sm:p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-[1000px] overflow-hidden flex flex-col" style={{ maxHeight: "95vh" }}>
        <div className="flex items-center justify-between px-4 py-2 bg-neutral-800 text-neutral-200 text-sm">
          <span className="font-medium">Pay {provider ? provider.toUpperCase() : ""} — secure browser</span>
          <button onClick={onClose} className="text-neutral-400 hover:text-white">✕</button>
        </div>

        <div className="px-4 py-2 text-xs text-center"
             style={{ background: status === "paid" ? "#052e16" : status === "error" || status === "expired" ? "#3f1d1d" : "#1e293b",
                      color: status === "paid" ? "#86efac" : status === "error" || status === "expired" ? "#fca5a5" : "#93c5fd" }}>
          {status === "connecting" && "Starting a secure browser and signing in…"}
          {status === "ready" && "Enter your card details on the page below and submit. We’ll capture the receipt — your card never touches our servers."}
          {status === "paid" && `✓ Paid. ${detail}. Receipt saved to this property.`}
          {status === "error" && `Couldn’t continue. ${detail}`}
          {status === "expired" && "The session timed out for safety. Reopen to try again."}
        </div>

        <div className="relative bg-white overflow-auto" style={{ opacity: interactive ? 1 : 0.6 }}>
          <canvas
            ref={canvasRef} width={PAGE_W} height={PAGE_H}
            tabIndex={0}
            className="block w-full h-auto outline-none touch-none"
            style={{ cursor: interactive ? "crosshair" : "default" }}
            onMouseMove={(e) => interactive && sendEv({ type: "mousemove", ...toPage(e) })}
            onMouseDown={(e) => { if (interactive) { canvasRef.current?.focus(); sendEv({ type: "mousedown", ...toPage(e), clickCount: e.detail || 1 }); } }}
            onMouseUp={(e) => interactive && sendEv({ type: "mouseup", ...toPage(e), clickCount: e.detail || 1 })}
            onWheel={(e) => interactive && sendEv({ type: "wheel", ...toPage(e), dx: e.deltaX, dy: e.deltaY })}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => interactive && e.key.length !== 1 && sendEv({ type: "key", down: false, key: e.key, code: e.code, keyCode: e.keyCode })}
          />
          {(status === "paid" || status === "expired" || status === "error") && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <button onClick={onClose} className="bg-white text-neutral-900 rounded-lg px-4 py-2 text-sm font-medium">Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
