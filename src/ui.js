import React, { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// Reusable UI Component Library
// Single source of truth for all visual patterns.
// To restyle the app, modify these components — not App.js.
// ============================================================

// ---- BUTTON ----
const BTN_BASE = "inline-flex items-center justify-center font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_VARIANTS = {
  primary:   "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "text-brand-600 border border-brand-200 hover:bg-brand-50 bg-white",
  danger:    "text-danger-600 border border-danger-200 hover:bg-danger-50 bg-white",
  "danger-fill": "bg-danger-600 text-white hover:bg-danger-700",
  success:   "text-success-600 border border-success-200 hover:bg-success-50 bg-white",
  "success-fill": "bg-success-600 text-white hover:bg-success-700",
  // Positive has its own palette (softer green than success). Useful for
  // confirmations and "approve/authorize" affordances where we already
  // use positive- tokens elsewhere in the theme.
  positive:  "text-positive-700 border border-positive-200 hover:bg-positive-100 bg-positive-50",
  "positive-fill": "bg-positive-600 text-white hover:bg-positive-700",
  // Notice = pause/warn-ish. Used for Pause-toggle affordances in Autopay.
  notice:    "text-notice-500 border border-notice-200 hover:bg-notice-50 bg-white",
  ghost:     "text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100",
  purple:    "text-highlight-600 border border-highlight-200 hover:bg-highlight-50 bg-white",
  amber:     "text-warn-600 border border-warn-200 hover:bg-warn-50 bg-white",
  "warning-fill": "bg-warn-600 text-white hover:bg-warn-700",
  slate:     "text-neutral-600 bg-neutral-100 hover:bg-neutral-200",
};
const BTN_SIZES = {
  xs: "text-xs px-2 py-1 rounded-lg gap-1",
  sm: "text-xs px-3 py-1.5 rounded-lg gap-1.5",
  md: "text-sm px-3.5 py-1.5 rounded-xl gap-1.5",
  lg: "text-sm px-5 py-2 rounded-2xl gap-2",
};

export function Btn({ variant = "primary", size = "md", className = "", icon, children, ...props }) {
  return (
    <button className={`${BTN_BASE} ${BTN_VARIANTS[variant] || BTN_VARIANTS.primary} ${BTN_SIZES[size] || BTN_SIZES.md} ${className}`} {...props}>
      {icon && <span className="material-icons-outlined text-sm">{icon}</span>}
      {children}
    </button>
  );
}

// ---- ICON BUTTON ----
export function IconBtn({ icon, className = "", title, ...props }) {
  return (
    <button className={`w-8 h-8 flex items-center justify-center rounded-xl text-neutral-400 hover:bg-neutral-100 transition-colors ${className}`} title={title} {...props}>
      <span className="material-icons-outlined text-lg">{icon}</span>
    </button>
  );
}

// ---- CARD ----
export function Card({ className = "", padding = "p-5", children, ...props }) {
  return (
    <div className={`bg-white rounded-3xl shadow-card border border-brand-50 ${padding} ${className}`} {...props}>
      {children}
    </div>
  );
}

// ---- INPUT / SELECT / TEXTAREA ----
// Size tokens — keep "md" as the default so existing screens don't shift.
// Use size="sm" for dense admin/settings forms where vertical space matters.
const INPUT_SIZES = {
  sm: "px-2.5 py-1 text-xs rounded-lg",
  md: "px-3 py-1.5 text-sm rounded-xl",
};
const INPUT_COMMON = "border border-brand-100 focus:border-brand-300 focus:outline-none transition-colors";
function inputBase(size, hasExplicitWidth) {
  return `${INPUT_COMMON} ${INPUT_SIZES[size] || INPUT_SIZES.md}${hasExplicitWidth ? "" : " w-full"}`;
}

export function Input({ className = "", size = "md", ...props }) {
  // Auto-apply sensible defaults by type
  const defaults = {};
  if (props.type === "date") { defaults.min = props.min || "2000-01-01"; defaults.max = props.max || "2099-12-31"; }
  else if (props.type === "email") { defaults.maxLength = props.maxLength || 254; }
  else if (props.type === "tel") { defaults.maxLength = props.maxLength || 14; }
  else if (props.type === "number") { defaults.step = props.step || "any"; }
  else if (props.type === "text" && !props.maxLength) { defaults.maxLength = 200; }
  const base = inputBase(size, /\bw-/.test(className));
  return <input className={`${base} ${className}`} {...defaults} {...props} />;
}

export function Select({ className = "", filter, size = "md", children, ...props }) {
  const base = inputBase(size, filter || /\bw-/.test(className));
  const widthCls = filter ? " w-auto" : "";
  return <select className={`${base}${widthCls} ${className}`} {...props}>{children}</select>;
}

export function Textarea({ className = "", rows = 3, size = "md", ...props }) {
  const base = inputBase(size, /\bw-/.test(className));
  return <textarea className={`${base} ${className}`} rows={rows} maxLength={props.maxLength || 5000} {...props} />;
}

// ---- FORM FIELD (label + input wrapper) ----
export function FormField({ label, required, className = "", size = "md", children }) {
  const labelCls = size === "sm"
    ? "text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1"
    : "text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1";
  return (
    <div className={className}>
      {label && (
        <label className={labelCls}>
          {label} {required && "*"}
        </label>
      )}
      {children}
    </div>
  );
}

// ---- BADGE ----
const BADGE_COLORS = {
  green:  "bg-success-50 text-success-700 border-success-200",
  red:    "bg-danger-50 text-danger-700 border-danger-200",
  yellow: "bg-warn-50 text-warn-700 border-warn-200",
  blue:   "bg-info-50 text-info-700 border-info-200",
  purple: "bg-highlight-50 text-highlight-700 border-highlight-200",
  gray:   "bg-neutral-50 text-neutral-600 border-neutral-200",
  indigo: "bg-brand-50 text-brand-700 border-brand-200",
};
const STATUS_MAP = {
  active: "green", occupied: "green", paid: "green", completed: "green", sent: "green", posted: "green",
  pending: "yellow", in_progress: "yellow", open: "yellow", draft: "yellow", unpaid: "yellow", notice: "yellow",
  inactive: "gray", vacant: "gray", archived: "gray", cancelled: "gray",
  overdue: "red", urgent: "red", emergency: "red", rejected: "red", failed: "red",
  high: "red", normal: "blue", low: "gray",
};

export function Badge({ status, label, color, className = "" }) {
  const resolvedColor = color || STATUS_MAP[status] || STATUS_MAP[label?.toLowerCase()] || "gray";
  const displayLabel = label || (status ? status.replace(/_/g, " ") : "");
  return (
    <span className={`inline-flex items-center text-xs font-bold px-2.5 py-0.5 rounded-full border ${BADGE_COLORS[resolvedColor] || BADGE_COLORS.gray} ${className}`}>
      {displayLabel}
    </span>
  );
}

// ---- PAGE HEADER ----
export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between mb-5 gap-2">
      <div>
        <h2 className="text-xl md:text-2xl font-manrope font-bold text-neutral-800">{title}</h2>
        {subtitle && <p className="text-xs text-neutral-400 mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

// ---- SECTION TITLE (within a page) ----
export function SectionTitle({ children, className = "" }) {
  return <h3 className={`font-manrope font-bold text-neutral-700 text-sm mb-3 uppercase tracking-wide ${className}`}>{children}</h3>;
}

// ---- EMPTY STATE ----
export function EmptyState({ icon = "inbox", title, subtitle }) {
  return (
    <div className="text-center py-16 text-neutral-400">
      <span className="material-icons-outlined text-4xl mb-2">{icon}</span>
      {title && <p className="text-sm font-medium">{title}</p>}
      {subtitle && <p className="text-xs mt-1">{subtitle}</p>}
    </div>
  );
}

// ---- TAB BAR ----
export function TabBar({ tabs, active, onChange, size = "md" }) {
  const sizeClass = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  return (
    <div className="flex gap-1 overflow-x-auto">
      {tabs.map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)}
          className={`${sizeClass} font-medium rounded-lg whitespace-nowrap transition-colors ${active === id ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- STAT CARD (dashboard) ----
export function StatCard({ label, value, icon, color = "indigo", trend }) {
  const bgMap = { indigo: "bg-brand-50", green: "bg-success-50", red: "bg-danger-50", amber: "bg-warn-50", purple: "bg-highlight-50" };
  const textMap = { indigo: "text-brand-600", green: "text-success-600", red: "text-danger-600", amber: "text-warn-600", purple: "text-highlight-600" };
  return (
    <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-5">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 ${bgMap[color]} rounded-2xl flex items-center justify-center`}>
          <span className={`material-icons-outlined ${textMap[color]}`}>{icon}</span>
        </div>
        <div>
          <div className="text-xs text-neutral-400 font-medium">{label}</div>
          <div className="text-xl font-manrope font-bold text-neutral-800">{value}</div>
          {trend && <div className="text-xs text-success-600 font-medium">{trend}</div>}
        </div>
      </div>
    </div>
  );
}

// ---- BULK ACTION BAR ----
export function BulkBar({ count, label = "item", children, onDeselect }) {
  return (
    <div className="bg-brand-50 border border-brand-200 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between">
      <span className="text-sm font-medium text-brand-800">{count} {label}{count > 1 ? "s" : ""} selected</span>
      <div className="flex gap-2">
        {children}
        <button onClick={onDeselect} className="text-xs text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-100">Deselect</button>
      </div>
    </div>
  );
}

// ---- ACCOUNT PICKER (typeahead) ----
export function AccountPicker({ value, onChange, accounts = [], accountTypes = [], showNewOption, placeholder = "Search accounts...", className = "" }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Resolve display text for current value
  const selected = accounts.find(a => a.id === value);
  const displayText = selected ? `${selected.code || "•"} ${selected.name}` : "";

  // Filter accounts by search
  const q = search.toLowerCase();
  const filtered = q
    ? accounts.filter(a => a.is_active !== false && (
        (a.name || "").toLowerCase().includes(q) ||
        (a.code || "").toLowerCase().includes(q) ||
        (a.type || "").toLowerCase().includes(q)
      ))
    : accounts.filter(a => a.is_active !== false);

  // Group filtered accounts by type
  const types = accountTypes.length ? accountTypes : [...new Set(filtered.map(a => a.type))];
  const grouped = types.map(type => ({
    type,
    items: filtered.filter(a => a.type === type),
  })).filter(g => g.items.length > 0);

  // Flat list for keyboard nav
  const flatItems = [];
  if (showNewOption) flatItems.push({ id: "__new__", label: "+ New Account", type: "__special__" });
  grouped.forEach(g => g.items.forEach(a => flatItems.push(a)));

  // Close on outside click
  useEffect(() => {
    function handleClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlighted >= 0 && listRef.current) {
      const el = listRef.current.querySelector(`[data-idx="${highlighted}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }, [highlighted]);

  const select = useCallback((id) => {
    onChange(id);
    setOpen(false);
    setSearch("");
    setHighlighted(-1);
  }, [onChange]);

  function handleKeyDown(e) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, flatItems.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && highlighted >= 0) { e.preventDefault(); select(flatItems[highlighted].id); }
    else if (e.key === "Escape") { setOpen(false); setSearch(""); }
    else if (e.key === "Tab") { setOpen(false); setSearch(""); }
  }

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={open ? search : displayText}
        placeholder={value ? displayText : placeholder}
        onChange={e => { setSearch(e.target.value); setHighlighted(-1); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); setSearch(""); }}
        onKeyDown={handleKeyDown}
        className={`${inputBase("md", false)} ${className} pr-7 text-xs`}
        autoComplete="off"
      />
      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-300 pointer-events-none text-xs">▾</span>
      {value && !open && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onChange(""); setSearch(""); inputRef.current?.focus(); }}
          className="absolute right-6 top-1/2 -translate-y-1/2 text-neutral-300 hover:text-neutral-500 text-xs"
          tabIndex={-1}>✕</button>
      )}
      {open && (
        <div ref={listRef} className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-brand-100 rounded-xl shadow-lg max-h-56 overflow-y-auto">
          {showNewOption && (
            <button type="button" data-idx={0}
              onMouseDown={(e) => { e.preventDefault(); select("__new__"); }}
              className={`w-full text-left px-3 py-1.5 text-xs font-semibold text-brand-600 hover:bg-brand-50 ${highlighted === 0 ? "bg-brand-50" : ""}`}>
              + New Account
            </button>
          )}
          {grouped.length === 0 && <div className="px-3 py-3 text-xs text-neutral-400 text-center">No accounts match "{search}"</div>}
          {grouped.map(g => (
            <div key={g.type}>
              <div className="px-3 py-1 text-[10px] font-bold text-neutral-400 uppercase tracking-wider bg-neutral-50 sticky top-0">{g.type}</div>
              {g.items.map(a => {
                const idx = flatItems.indexOf(a);
                return (
                  <button type="button" key={a.id} data-idx={idx}
                    onMouseDown={(e) => { e.preventDefault(); select(a.id); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-brand-50 flex items-center gap-1 ${highlighted === idx ? "bg-brand-50 text-brand-700" : "text-neutral-700"} ${a.id === value ? "font-semibold" : ""}`}>
                    <span className="text-neutral-400 w-10 shrink-0 font-mono">{a.code || "•"}</span>
                    <span className="truncate">{a.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- FILTER PILL ----
export function FilterPill({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${active ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
      {children}
    </button>
  );
}

// ---- CHECKBOX ----
// Pairs an <input type=checkbox> with an optional label. When `label` is
// passed, the entire row is clickable (label wraps input). If the caller
// needs bare-input semantics (e.g., inside a custom grid cell), pass
// `label={null}` and render its own <label>.
export function Checkbox({ label, className = "", ...props }) {
  const input = (
    <input type="checkbox" className="rounded border-brand-200 text-brand-600 focus:ring-brand-300" {...props} />
  );
  if (label == null) return input;
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-neutral-700 ${className}`}>
      {input}
      <span>{label}</span>
    </label>
  );
}

// ---- RADIO ----
export function Radio({ label, className = "", ...props }) {
  const input = (
    <input type="radio" className="border-brand-200 text-brand-600 focus:ring-brand-300" {...props} />
  );
  if (label == null) return input;
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-neutral-700 ${className}`}>
      {input}
      <span>{label}</span>
    </label>
  );
}

// ---- FILE INPUT ----
// Styles the native file picker button. For hidden-input + "Upload" button
// patterns, pass a ref and className="hidden" like any other input.
export function FileInput({ className = "", accept, ...props }) {
  return (
    <input
      type="file"
      accept={accept}
      className={`text-xs file:mr-2 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-brand-700 hover:file:bg-brand-100 ${className}`}
      {...props}
    />
  );
}

// ---- TEXT LINK ----
// Underline-on-hover button that mirrors the common `text-xs text-COLOR-600
// hover:underline` pattern used for inline row actions (Edit / Delete /
// Report). Not a routed <a> — purely a click handler with link visuals.
export function TextLink({ tone = "brand", size = "xs", className = "", children, ...props }) {
  const tones = {
    brand:   "text-brand-600 hover:text-brand-700",
    danger:  "text-danger-500 hover:text-danger-700",
    neutral: "text-neutral-500 hover:text-neutral-700",
    success: "text-success-600 hover:text-success-700",
  };
  const sizes = { xs: "text-xs", sm: "text-sm" };
  return (
    <button className={`${tones[tone] || tones.brand} ${sizes[size] || sizes.xs} hover:underline ${className}`} {...props}>
      {children}
    </button>
  );
}

// ---- CHIP ----
// Small rounded pill for interactive, non-status labels — e.g. an "Edit"
// or "Filter by X" affordance. Separate from <Badge> (which is for static
// status indicators like "Paid" / "Overdue").
export function Chip({ tone = "neutral", className = "", children, ...props }) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-600 hover:bg-neutral-200",
    brand:   "bg-brand-50 text-brand-700 hover:bg-brand-100",
    success: "bg-success-50 text-success-700 hover:bg-success-100",
    danger:  "bg-danger-50 text-danger-700 hover:bg-danger-100",
  };
  return (
    <button className={`text-xs px-2.5 py-0.5 rounded-full font-medium transition-colors ${tones[tone] || tones.neutral} ${className}`} {...props}>
      {children}
    </button>
  );
}
