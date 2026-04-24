import React, { useEffect, useRef, useState } from "react";

// Pull-to-refresh wrapper for a scroll container.
//
// iOS PWAs in standalone mode don't get Safari's native reload gesture,
// and we've opted into overscroll-contain to stop the rubber-band from
// desyncing the header and sidebar — which also kills any implicit
// pull-to-refresh. This component reintroduces it explicitly: while the
// scroll container is at scrollTop 0 and the user drags down, we track
// the pull ourselves, show an indicator that follows the finger, and
// fire onRefresh when they release past the threshold.
//
// The scroll container is `children` rendered inside a relative wrapper
// that also hosts the indicator. The element the user scrolls is passed
// in via scrollRef (forwarded from the parent) so we can read its
// scrollTop without requiring this component to own the scroll.
//
// Keeps state minimal — no extra re-renders during drag; indicator
// position is driven by a ref + direct style mutation, so React only
// re-renders on refresh-start / refresh-end.
export default function PullToRefresh({ onRefresh, scrollRef, children, className = "" }) {
  const indicatorRef = useRef(null);
  const pullRef = useRef({ active: false, startY: 0, delta: 0 });
  const [refreshing, setRefreshing] = useState(false);

  // Threshold in pixels. Matches native iOS feel (~60-70px pull to
  // trigger). Higher = harder to trigger accidentally while scrolling;
  // lower = easier but more false positives.
  const THRESHOLD = 70;
  const MAX_PULL = 110;

  useEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;

    const indicator = indicatorRef.current;

    const setIndicator = (delta, spinning = false) => {
      if (!indicator) return;
      const clamped = Math.min(delta, MAX_PULL);
      indicator.style.transform = `translateX(-50%) translateY(${clamped - 48}px)`;
      indicator.style.opacity = Math.min(1, clamped / THRESHOLD).toString();
      const icon = indicator.querySelector(".p2r-icon");
      if (icon) {
        if (spinning) {
          icon.classList.add("p2r-spin");
          icon.style.transform = "rotate(0deg)";
        } else {
          icon.classList.remove("p2r-spin");
          icon.style.transform = `rotate(${Math.min(180, (clamped / THRESHOLD) * 180)}deg)`;
        }
      }
    };

    // Belt-and-suspenders zoom check. Pinching zooms the visual
    // viewport; if the page is zoomed in at all, pull-to-refresh is
    // disabled. Prevents the "pinch out anywhere triggers reload"
    // case even if the multi-touch filter misses an edge in mid-gesture.
    const isZoomed = () => {
      const vv = typeof window !== "undefined" && window.visualViewport;
      if (!vv) return false;
      return Math.abs(vv.scale - 1) > 0.02;
    };

    // If the touch started inside a nested scroll container (e.g., a
    // slide-over drawer with its own overflow-y-auto), don't pull.
    // Without this, touch events bubble up to <main>, main.scrollTop
    // is still 0 because the actual scroll is happening in the drawer,
    // and the user's swipe-to-scroll inside the drawer gets read as a
    // pull-to-refresh on main — which reloaded the page from inside
    // the property detail drawer.
    const isInsideNestedScroll = (target) => {
      let node = target;
      while (node && node !== el && node.nodeType === 1) {
        const s = window.getComputedStyle(node);
        const oy = s.overflowY;
        if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const onTouchStart = (e) => {
      if (refreshing) return;
      if (isZoomed()) { pullRef.current.active = false; return; }
      // Multi-touch = pinch/zoom. Don't track — otherwise the second
      // finger moving down reads as a pull-down and triggers the
      // reload (user reported this when pinching out to un-zoom on the
      // Properties search field).
      if (e.touches.length > 1) { pullRef.current.active = false; return; }
      // Nested scroll container (drawers, modals, inner lists) —
      // user is scrolling that, not pulling the page.
      if (isInsideNestedScroll(e.target)) { pullRef.current.active = false; return; }
      if (el.scrollTop > 0) { pullRef.current.active = false; return; }
      pullRef.current.active = true;
      pullRef.current.startX = e.touches[0].clientX;
      pullRef.current.startY = e.touches[0].clientY;
      pullRef.current.delta = 0;
      pullRef.current.axisLocked = false;
    };

    const onTouchMove = (e) => {
      if (!pullRef.current.active || refreshing) return;
      // If a second finger landed during the drag (pinch starting),
      // OR the user has zoomed in since touchstart, abort and let the
      // browser handle zoom. Without this, the pull indicator sticks
      // around during the pinch and can fire on release.
      if (e.touches.length > 1 || isZoomed()) {
        pullRef.current.active = false;
        pullRef.current.delta = 0;
        setIndicator(0);
        return;
      }
      const dx = e.touches[0].clientX - pullRef.current.startX;
      const dy = e.touches[0].clientY - pullRef.current.startY;
      // Axis lock. Until total movement clears the deadzone, don't do
      // anything — prevents tiny finger drift from showing the
      // indicator. Once it clears, commit to one axis: if the motion
      // so far is more horizontal than vertical, abort this gesture
      // entirely (user is swiping sideways — carousel, horizontal tab
      // scroll, just resting their thumb). Requires dy to lead dx by
      // 1.5x before locking to vertical so a mostly-sideways swipe
      // with small vertical drift doesn't read as a pull.
      if (!pullRef.current.axisLocked) {
        const AXIS_DEADZONE = 10;
        if (Math.abs(dx) < AXIS_DEADZONE && Math.abs(dy) < AXIS_DEADZONE) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.5 || dy < 0) {
          pullRef.current.active = false;
          return;
        }
        pullRef.current.axisLocked = true;
      }
      if (dy <= 0) {
        // User swiped back up — reset and let native scroll resume.
        pullRef.current.delta = 0;
        setIndicator(0);
        return;
      }
      // Apply a rubber-band resistance curve so long pulls feel heavy
      // instead of tracking 1:1 forever.
      const resisted = Math.min(MAX_PULL, dy * 0.55);
      pullRef.current.delta = resisted;
      setIndicator(resisted);
      // Prevent iOS from also doing its rubber-band on the container.
      e.preventDefault();
    };

    const onTouchEnd = async () => {
      if (!pullRef.current.active) return;
      const delta = pullRef.current.delta;
      pullRef.current.active = false;
      if (delta >= THRESHOLD) {
        setRefreshing(true);
        setIndicator(THRESHOLD, true);
        try {
          await Promise.resolve(onRefresh?.());
        } catch (_e) { /* swallowed — the refresh handler logs its own errors */ }
        setRefreshing(false);
        setIndicator(0);
      } else {
        setIndicator(0);
      }
      pullRef.current.delta = 0;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [scrollRef, onRefresh, refreshing]);

  return (
    <div className={"relative " + className}>
      {/* Indicator — absolutely positioned, follows the finger via the
          effect above. Hidden on desktop (no touch, no pull). */}
      <div
        ref={indicatorRef}
        className="pointer-events-none absolute left-1/2 top-0 z-50 md:hidden"
        style={{ transform: "translateX(-50%) translateY(-48px)", opacity: 0 }}
      >
        <div className="w-10 h-10 rounded-full bg-white shadow-lg border border-brand-100 flex items-center justify-center">
          <span
            className="p2r-icon material-icons-outlined text-brand-600 text-xl"
            style={{ transition: "transform 80ms linear" }}
          >
            {refreshing ? "autorenew" : "arrow_downward"}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}
