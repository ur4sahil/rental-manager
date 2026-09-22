import React, { useEffect, useRef, useState, useCallback } from "react";

// A real browser, running on the VPS, rendered here on a canvas. The person sees
// the utility's own card page and types their card into it; the keystrokes travel
// to that browser and the card goes browser → utility over HTTPS. Nothing about
// the card touches PropManager — no state, no storage, no logging.
//
// DESKTOP and MOBILE need different input:
//   • Desktop has a real keyboard + mouse — relay key events directly (Tab,
//     Backspace, Enter and typing all work), like a normal browser.
//   • Mobile has no physical keyboard and a <canvas> can't raise the on-screen
//     one, so a tap focuses a visible "type-bar" whose keystrokes are relayed,
//     and a swipe scrolls the remote page.
const PAGE_W = 1280;
const PAGE_H = 900;
const IS_TOUCH = typeof window !== "undefined"
  && (("ontouchstart" in window) || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches));

export default function StreamedBrowser({ url, provider, streamBase, token, onPaid, onClose }) {
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const imgRef = useRef(typeof Image !== "undefined" ? new Image() : null);
  const kbRef = useRef(null);         // mobile type-bar
  const kbValRef = useRef("");        // last type-bar value, to diff into keystrokes
  const [status, setStatus] = useState("connecting"); // connecting | ready | paid | error | expired
  const [detail, setDetail] = useState("");
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

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

    ws.onerror = () => { if (alive) { setStatus("error"); setDetail("Could not reach the browser service."); } };
    ws.onclose = (e) => { if (alive && e.code === 4000) setStatus("expired"); };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "frame") {
        const img = imgRef.current, cv = canvasRef.current;
        if (!img || !cv) return;
        img.onload = () => { const ctx = cv.getContext("2d"); ctx && ctx.drawImage(img, 0, 0, PAGE_W, PAGE_H); };
        img.src = "data:image/jpeg;base64," + msg.data;
      } else if (msg.type === "status") {
        setDetail(msg.message || "");
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
    return () => { alive = false; try { ws.close(); } catch {} };
  }, [streamBase, provider, url, token, onPaid]);

  // ---- DESKTOP: relay the physical keyboard straight through ----------------
  const onCanvasKeyDown = useCallback((e) => {
    if (statusRef.current !== "ready") return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); sendEv({ type: "text", text: e.key });
    } else if (["Tab", "Backspace", "Enter", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(e.key)) {
      e.preventDefault(); sendEv({ type: "key", down: true, key: e.key, code: e.code, keyCode: e.keyCode });
    }
  }, [sendEv]);
  const onCanvasKeyUp = useCallback((e) => {
    if (statusRef.current !== "ready") return;
    if (e.key.length !== 1) sendEv({ type: "key", down: false, key: e.key, code: e.code, keyCode: e.keyCode });
  }, [sendEv]);

  // ---- MOBILE: type-bar keystroke relay ------------------------------------
  const focusKeyboard = useCallback(() => {
    const el = kbRef.current; if (el) { try { el.focus({ preventScroll: true }); } catch { el.focus(); } }
  }, []);
  const clearBar = useCallback(() => { const el = kbRef.current; if (el) el.value = ""; kbValRef.current = ""; }, []);
  const onKbInput = useCallback(() => {
    const el = kbRef.current; if (!el) return;
    const nv = el.value, ov = kbValRef.current;
    if (nv.length > ov.length && nv.startsWith(ov)) {
      for (const ch of nv.slice(ov.length)) sendEv({ type: "text", text: ch });
    } else if (nv.length < ov.length && ov.startsWith(nv)) {
      for (let i = 0; i < ov.length - nv.length; i++) sendEv({ type: "key", down: true, key: "Backspace", code: "Backspace", keyCode: 8 });
    } else if (nv !== ov) {
      for (let i = 0; i < ov.length; i++) sendEv({ type: "key", down: true, key: "Backspace", code: "Backspace", keyCode: 8 });
      for (const ch of nv) sendEv({ type: "text", text: ch });
    }
    kbValRef.current = nv;
    if (nv.length > 40) { el.value = ""; kbValRef.current = ""; }
  }, [sendEv]);
  const onKbKeyDown = useCallback((e) => {
    if (e.key === "Enter") { e.preventDefault(); sendEv({ type: "key", down: true, key: "Enter", code: "Enter", keyCode: 13 }); }
    else if (e.key === "Backspace" && kbRef.current && kbRef.current.value === "") {
      sendEv({ type: "key", down: true, key: "Backspace", code: "Backspace", keyCode: 8 });
    }
  }, [sendEv]);

  // ---- MOBILE touch: swipe scrolls the remote page, tap clicks + refocuses --
  useEffect(() => {
    if (!IS_TOUCH) return;
    const c = canvasRef.current; if (!c) return;
    const st = { y: 0, moved: false };
    const pt = (cx, cy) => { const r = c.getBoundingClientRect(); return { x: (cx - r.left) * (PAGE_W / r.width), y: (cy - r.top) * (PAGE_H / r.height), ratio: PAGE_H / r.height }; };
    const onStart = (e) => { const t = e.touches[0]; st.y = t.clientY; st.moved = false; };
    const onMove = (e) => {
      if (statusRef.current !== "ready") return;
      const t = e.touches[0]; const dy = st.y - t.clientY;
      if (st.moved || Math.abs(dy) > 4) {
        e.preventDefault(); st.moved = true;
        const p = pt(t.clientX, t.clientY);
        sendEv({ type: "wheel", x: p.x, y: p.y, dx: 0, dy: dy * p.ratio });
        st.y = t.clientY;
      }
    };
    const onEnd = (e) => {
      if (statusRef.current !== "ready" || st.moved) return;
      e.preventDefault();
      const t = e.changedTouches[0]; const p = pt(t.clientX, t.clientY);
      sendEv({ type: "mousedown", x: p.x, y: p.y, clickCount: 1 });
      sendEv({ type: "mouseup", x: p.x, y: p.y, clickCount: 1 });
      clearBar();          // new field → start a fresh buffer so fields don't concatenate
      const el = kbRef.current; if (el) { try { el.focus({ preventScroll: true }); } catch { el.focus(); } }
    };
    c.addEventListener("touchstart", onStart, { passive: true });
    c.addEventListener("touchmove", onMove, { passive: false });
    c.addEventListener("touchend", onEnd, { passive: false });
    return () => { c.removeEventListener("touchstart", onStart); c.removeEventListener("touchmove", onMove); c.removeEventListener("touchend", onEnd); };
  }, [sendEv, clearBar]);

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
          {status === "connecting" && (detail || "Starting a secure browser and signing in…")}
          {status === "ready" && (IS_TOUCH
            ? "Tap a field, type in the bar below, then submit. Your card never touches our servers."
            : "Click a field and type as you normally would — Tab, Backspace and Enter all work. Your card never touches our servers.")}
          {status === "paid" && `✓ Paid. ${detail}. Receipt saved to this property.`}
          {status === "error" && `Couldn’t continue. ${detail}`}
          {status === "expired" && "The session timed out for safety. Reopen to try again."}
        </div>

        <div className="relative bg-white overflow-hidden" style={{ opacity: interactive ? 1 : 0.6 }}>
          <canvas
            ref={canvasRef} width={PAGE_W} height={PAGE_H}
            tabIndex={IS_TOUCH ? undefined : 0}
            className="block w-full h-auto outline-none select-none"
            onMouseMove={(e) => interactive && sendEv({ type: "mousemove", ...toPage(e) })}
            onMouseDown={(e) => { if (interactive) { sendEv({ type: "mousedown", ...toPage(e), clickCount: e.detail || 1 }); if (!IS_TOUCH) canvasRef.current?.focus(); } }}
            onMouseUp={(e) => interactive && sendEv({ type: "mouseup", ...toPage(e), clickCount: e.detail || 1 })}
            onWheel={(e) => interactive && sendEv({ type: "wheel", ...toPage(e), dx: e.deltaX, dy: e.deltaY })}
            onKeyDown={IS_TOUCH ? undefined : onCanvasKeyDown}
            onKeyUp={IS_TOUCH ? undefined : onCanvasKeyUp}
          />
          {status === "connecting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white gap-3">
              <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <div className="text-sm text-neutral-500 px-6 text-center">{detail || "Loading…"}</div>
            </div>
          )}
          {(status === "paid" || status === "expired" || status === "error") && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <button onClick={onClose} className="bg-white text-neutral-900 rounded-lg px-4 py-2 text-sm font-medium">Done</button>
            </div>
          )}
        </div>

        {/* Type-bar: MOBILE ONLY. Desktop types straight into the canvas above. */}
        {interactive && IS_TOUCH && (
          <div className="px-3 py-2 bg-neutral-800 border-t border-neutral-700">
            <input
              ref={kbRef}
              onInput={onKbInput}
              onKeyDown={onKbKeyDown}
              type="text" inputMode="text"
              autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false}
              placeholder="Tap a field above, then type here…"
              className="w-full rounded-lg px-3 py-2.5 text-base bg-white text-neutral-900 placeholder-neutral-400 outline-none"
            />
            <div className="text-[11px] text-neutral-400 mt-1 text-center">Goes to the field you tapped · swipe the page to scroll · Enter to submit</div>
          </div>
        )}
      </div>
    </div>
  );
}
