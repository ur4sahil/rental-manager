// ============ COMMAND PALETTE (Cmd+K) ============
//
// One search box that reaches every page, sub-page and quick action the
// signed-in user is allowed to see. Opened with Cmd+K (Ctrl+K on
// Windows/Linux), driven entirely by the keyboard: type to filter,
// arrows to move, Enter to run, Escape to close.
//
// The command list is built from the SAME role-filtered nav the sidebar
// renders, so the palette can never offer a page the user isn't
// permitted to open.

import React, { useState, useEffect, useMemo, useRef } from "react";
import { openShortcuts } from "./KeyboardShortcuts";

// Subsequence match: every character of the query must appear in order,
// so "jrnl" finds "Journal Entries" and "pl prop" finds "P&L by
// Property". Returns a score where LOWER is better, or null for no
// match.
//
// null rather than -1 for the miss: adjacency and word-boundary bonuses
// subtract, so a strong match is legitimately negative — "acc" against
// "Accounting" scores -6. Using a negative sentinel and filtering
// `score >= 0` silently discarded exactly the best matches.
function fuzzyScore(text, query) {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  let ti = 0, score = 0, prevHit = -1, firstHit = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (firstHit === -1) firstHit = found;
    // Reward adjacent characters and matches at a word boundary; that
    // keeps "rec" scoring "Reconcile" above "Recurring Entries" only
    // when the letters actually run together.
    if (prevHit !== -1 && found === prevHit + 1) score -= 3;
    if (found === 0 || /[\s\-–—:/]/.test(t[found - 1] || "")) score -= 2;
    score += found - (prevHit === -1 ? 0 : prevHit);
    prevHit = found;
    ti = found + 1;
  }
  return score + firstHit;
}

export function CommandPalette({ open, onClose, nav = [], onNavigate, onSwitchCompany, companyName, currentPage }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Build the command list from the role-filtered nav, so nothing the
  // user can't reach is ever offered.
  const commands = useMemo(() => {
    const out = [];
    for (const item of nav) {
      out.push({
        id: item.id, kind: "page", label: item.label, icon: item.icon || "chevron_right",
        group: "Go to", keywords: item.label,
        run: () => onNavigate(item.id),
      });
      for (const child of item.children || []) {
        out.push({
          id: child.id, kind: "page", label: child.label, icon: child.icon || "chevron_right",
          group: "Go to", context: item.label,
          // Include the parent so "accounting reconcile" matches too.
          keywords: `${item.label} ${child.label}`,
          run: () => onNavigate(child.id),
        });
      }
    }
    const canAccount = nav.some(n => n.id === "accounting" || (n.children || []).some(c => c.id.startsWith("acct_")));
    if (canAccount) {
      out.push({ id: "new-je", kind: "action", label: "New journal entry", icon: "post_add",
        group: "Actions", keywords: "new journal entry create je add",
        run: () => onNavigate("acct_journal", "newJE") });
      out.push({ id: "qb-import", kind: "action", label: "Import from QuickBooks", icon: "cloud_upload",
        group: "Actions", keywords: "import quickbooks qbo ledger",
        run: () => onNavigate("acct_qbimport") });
    }
    out.push({ id: "shortcuts", kind: "action", label: "Keyboard shortcuts", icon: "keyboard",
      group: "Actions", keywords: "keyboard shortcuts keys help hotkeys cheat sheet",
      run: () => openShortcuts() });
    if (onSwitchCompany) {
      out.push({ id: "switch-co", kind: "action", label: "Switch company", icon: "swap_horiz",
        group: "Actions", keywords: "switch change company organisation organization",
        context: companyName || "", run: () => onSwitchCompany() });
    }
    return out;
  }, [nav, onNavigate, onSwitchCompany, companyName]);

  const results = useMemo(() => {
    if (!query.trim()) {
      // With no query, lead with actions then the pages, and keep the
      // page the user is already on out of the way.
      return commands.filter(c => c.id !== currentPage).slice(0, 12);
    }
    return commands
      // Score against the item's own label AND against the label with
      // its parent ("Accounting Journal Entries"), keeping the better of
      // the two. The parent form lets "accounting reconcile" match; on
      // its own it would bury a child under the parent's letters, which
      // ranked "New journal entry" above "Journal Entries" for "jrnl".
      .map(c => {
        const a = fuzzyScore(c.label, query);
        const b = c.keywords && c.keywords !== c.label ? fuzzyScore(c.keywords, query) : null;
        const s = a === null ? b : (b === null ? a : Math.min(a, b));
        return { c, s };
      })
      .filter(x => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 12)
      .map(x => x.c);
  }, [commands, query, currentPage]);

  // Reset each time it opens, and focus the box.
  useEffect(() => {
    if (!open) return;
    setQuery(""); setActive(0);
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${active}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (cmd) => { if (!cmd) return; onClose(); cmd.run(); };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(results[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    // Ctrl+N / Ctrl+P, for anyone who lives in a terminal.
    else if (e.ctrlKey && e.key === "n") { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.ctrlKey && e.key === "p") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
  };

  let lastGroup = null;

  return (
    <div className="fixed inset-0 z-[4000] flex items-start justify-center pt-[12vh] px-4"
         onMouseDown={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-neutral-200 overflow-hidden"
           onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-100">
          <span className="material-icons-outlined text-neutral-400 text-lg">search</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages and actions…"
            className="flex-1 text-sm outline-none placeholder:text-neutral-400"
            aria-label="Search pages and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-opt-${active}` : undefined}
            autoComplete="off"
          />
          <kbd className="text-[10px] text-neutral-400 border border-neutral-200 rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div ref={listRef} id="cmdk-list" role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-neutral-400">Nothing matches “{query}”.</p>
          )}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <React.Fragment key={c.id + i}>
                {header && (
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{header}</div>
                )}
                <button
                  id={`cmdk-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-left ${i === active ? "bg-brand-50" : "hover:bg-neutral-50"}`}
                >
                  <span className={`material-icons-outlined text-base ${i === active ? "text-brand-600" : "text-neutral-400"}`}>{c.icon}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-sm text-neutral-800">{c.label}</span>
                    {c.context && <span className="text-xs text-neutral-400 ml-2">{c.context}</span>}
                  </span>
                  {i === active && <kbd className="text-[10px] text-neutral-400 border border-neutral-200 rounded px-1.5 py-0.5">↵</kbd>}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-neutral-100 bg-neutral-50 text-[10px] text-neutral-400">
          <span><kbd className="border border-neutral-200 rounded px-1">↑</kbd> <kbd className="border border-neutral-200 rounded px-1">↓</kbd> move</span>
          <span><kbd className="border border-neutral-200 rounded px-1">↵</kbd> open</span>
          <span className="ml-auto">{companyName}</span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
