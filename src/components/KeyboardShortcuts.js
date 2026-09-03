// ============ KEYBOARD SHORTCUTS — REGISTRY + HELP ============
//
// One source of truth. The handlers in Banking.js and Accounting.js read
// their keys from here, and the help sheet renders from the same list,
// so what the app does and what it tells you it does cannot drift apart.
//
// Opened with "?" from anywhere, or from the command palette.

import React, { useState, useEffect, useCallback } from "react";

// isMac drives the label only — handlers accept either modifier, so a
// Mac user pressing Cmd and a Windows user pressing Ctrl both work.
const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
export const MOD = isMac ? "⌘" : "Ctrl";

export const SHORTCUT_GROUPS = [
  {
    id: "global",
    title: "Anywhere in the app",
    items: [
      { keys: [MOD, "K"], label: "Open the command palette — jump to any page or action" },
      { keys: ["?"], label: "Show this list" },
      { keys: ["Esc"], label: "Close whatever is open" },
    ],
  },
  {
    id: "review",
    title: "Bank Transactions — For Review",
    hint: "Select a row, then act on it without reaching for the mouse.",
    items: [
      { keys: ["↑", "↓"], label: "Move between transactions" },
      { keys: ["J", "K"], label: "Move down / up (same as the arrows)" },
      { keys: ["Enter"], label: "Open or close the selected transaction" },
      { keys: ["A"], label: "Add — categorise to an account" },
      { keys: ["M"], label: "Match to an existing journal entry" },
      { keys: ["T"], label: "Transfer between accounts" },
      { keys: ["S"], label: "Split across several accounts" },
      { keys: ["X"], label: "Exclude the transaction" },
      { keys: ["U"], label: "Undo — send a categorised one back to review" },
      { keys: [MOD, "Enter"], label: "Post it and jump to the next transaction" },
      { keys: ["Esc"], label: "Close the panel, keep the row selected" },
    ],
  },
  {
    id: "je",
    title: "Journal Entry form",
    hint: "Enter walks down the lines; on the last line it makes a new one.",
    items: [
      { keys: ["Enter"], label: "Add a line (from the last field of the last row)" },
      { keys: [MOD, "D"], label: "Duplicate the line above — same account, class and tenant" },
      { keys: [MOD, "B"], label: "Balance — fill the amount that squares the entry" },
      { keys: [MOD, "Enter"], label: "Save the entry" },
      { keys: [MOD, "⌫"], label: "Delete the current line" },
      { keys: ["Esc"], label: "Cancel" },
    ],
  },
];

// Keys the review queue claims. Exported so Banking.js and the help
// sheet cannot disagree about them.
export const REVIEW_KEYS = {
  down: ["arrowdown", "j"],
  up: ["arrowup", "k"],
  open: ["enter"],
  add: ["a"],
  match: ["m"],
  transfer: ["t"],
  split: ["s"],
  exclude: ["x"],
  undo: ["u"],
};

// True when the event came from somewhere a keystroke means text, so a
// single-letter shortcut never eats what someone is typing.
export function isTypingTarget(e) {
  const el = e.target;
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

// Any component can ask for the help sheet without prop-drilling through
// the router — App owns the single mount and listens for this.
export const SHORTCUTS_EVENT = "pm:open-shortcuts";
export function openShortcuts(scope) {
  document.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT, { detail: { scope } }));
}

// Binds "?" to open the help sheet. Skipped while typing, and while a
// modifier is held so it can't shadow a browser shortcut.
export function useShortcutHelpKey(onOpen) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e)) return;
      e.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onOpen]);
}

// Owns the single help-sheet mount for the app: "?" from anywhere, plus
// openShortcuts() from any component. `getScope` is called at open time
// so the sheet leads with the group for whatever page is showing.
export function useShortcutsHost(getScope) {
  const [shortcuts, setShortcuts] = useState(null); // null = closed
  useShortcutHelpKey(useCallback(
    () => setShortcuts(s => (s ? null : { scope: getScope() })), [getScope]));
  useEffect(() => {
    const onOpen = (e) => setShortcuts({ scope: e.detail?.scope || null });
    document.addEventListener(SHORTCUTS_EVENT, onOpen);
    return () => document.removeEventListener(SHORTCUTS_EVENT, onOpen);
  }, []);
  return [shortcuts, useCallback(() => setShortcuts(null), [])];
}

function Key({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] px-1.5 py-0.5 rounded border border-neutral-300 bg-white text-[11px] font-medium text-neutral-600 shadow-[0_1px_0_rgba(0,0,0,0.06)]">
      {children}
    </kbd>
  );
}

// `scope` highlights the group relevant to where the user is, so the
// sheet opens showing the keys that work right now rather than a wall.
export function ShortcutsHelp({ open, onClose, scope }) {
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  const groups = scope
    ? [...SHORTCUT_GROUPS].sort((a, b) => (a.id === scope ? -1 : b.id === scope ? 1 : 0))
    : SHORTCUT_GROUPS;

  return (
    <div className="fixed inset-0 z-[4100] flex items-start justify-center pt-[8vh] px-4 overflow-y-auto"
         onMouseDown={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-neutral-200 mb-10"
           onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
          <div>
            <h3 className="text-base font-semibold text-neutral-900">Keyboard shortcuts</h3>
            <p className="text-xs text-neutral-500 mt-0.5">Press <Key>?</Key> any time to bring this back.</p>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600" aria-label="Close">
            <span className="material-icons-outlined">close</span>
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[65vh] overflow-y-auto">
          {groups.map(g => (
            <section key={g.id}>
              <div className="flex items-baseline gap-2 mb-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{g.title}</h4>
                {g.id === scope && <span className="text-[10px] bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded-full">you're here</span>}
              </div>
              {g.hint && <p className="text-xs text-neutral-400 mb-2">{g.hint}</p>}
              <div className="rounded-xl border border-neutral-100 divide-y divide-neutral-100">
                {g.items.map((it, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="flex items-center gap-1 shrink-0 w-32">
                      {it.keys.map((k, j) => (
                        <React.Fragment key={j}>
                          {j > 0 && <span className="text-[10px] text-neutral-300">{it.keys.length === 2 && (it.keys[0] === "↑" || it.keys[0] === "J") ? "/" : "+"}</span>}
                          <Key>{k}</Key>
                        </React.Fragment>
                      ))}
                    </span>
                    <span className="text-sm text-neutral-700">{it.label}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-neutral-100 bg-neutral-50 text-xs text-neutral-500">
          Single-letter keys only fire when you aren't typing in a field.
        </div>
      </div>
    </div>
  );
}

// Small always-visible affordance so the shortcuts are discoverable
// without anyone having to guess that "?" does something.
export function ShortcutsHint({ onClick, className = "" }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 ${className}`}
      title="Keyboard shortcuts">
      <span className="material-icons-outlined text-sm">keyboard</span>
      <span className="hidden sm:inline">Shortcuts</span>
      <Key>?</Key>
    </button>
  );
}

export default ShortcutsHelp;
