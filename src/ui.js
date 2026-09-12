import React, { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// Reusable UI Component Library
// Single source of truth for all visual patterns.
// To restyle the app, modify these components — not App.js.
// ============================================================

// ---- BUTTON ----
// The keyboard focus ring.
//
// Btn, IconBtn and TextLink had NO focus state -- all 576 of them -- so
// keyboard and screen-reader users could not see where they were in the
// app at all. focus-visible rather than focus, so a mouse click does not
// leave a ring behind; ring-offset so the ring reads against a filled
// button as well as a white card.
//
// brand-400 specifically: it is visible both on white and on a brand-600
// fill. The ramp had no 400 step, which is a large part of why this was
// never done -- there was no right colour to reach for.
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1";

const BTN_BASE = "inline-flex items-center justify-center font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed " + FOCUS_RING;
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
  // Info (blue) — "Add Charge", informational/neutral-positive actions.
  info:      "text-info-700 border border-info-200 hover:bg-info-100 bg-info-50",
  // Accent (violet) — used for bank-rules engine affordances.
  accent:    "text-accent-700 border border-accent-200 hover:bg-accent-100 bg-accent-50",
  "accent-fill": "bg-accent-600 text-white hover:bg-accent-700",
  // Dark (neutral-800) — used for CSV import wizard Next/Back/Continue chrome.
  dark:      "bg-neutral-800 text-white hover:bg-neutral-700",
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

export function Btn({ variant = "primary", size = "md", className = "", icon, type, children, ...props }) {
  // Default to type="button". HTML's <button> defaults to type="submit",
  // which — if the button ever ends up inside a <form> — can fire an
  // implicit submit on Enter and trigger the *first* button's onClick
  // instead of the one the user intended. Pin type so our buttons stay
  // inert to form semantics unless a caller explicitly opts in.
  return (
    <button type={type || "button"} className={`${BTN_BASE} ${BTN_VARIANTS[variant] || BTN_VARIANTS.primary} ${BTN_SIZES[size] || BTN_SIZES.md} ${className}`} {...props}>
      {icon && <span className="material-icons-outlined text-sm">{icon}</span>}
      {children}
    </button>
  );
}

// ---- ICON BUTTON ----
export function IconBtn({ icon, className = "", title, ...props }) {
  return (
    <button className={`w-8 h-8 flex items-center justify-center rounded-xl text-neutral-400 hover:bg-neutral-100 transition-colors ${FOCUS_RING} ${className}`} title={title} {...props}>
      <span className="material-icons-outlined text-lg">{icon}</span>
    </button>
  );
}

// ---- CARD ----
// ---- SURFACES ----
// One recipe per KIND of surface, and nothing spells its own.
//
// The app had fourteen different ways to draw what is conceptually the
// same thing -- a panel with content in it. The top few, by count:
//
//     47x  rounded-xl  border border-neutral-200
//     47x  rounded-3xl shadow-card
//     39x  rounded-3xl border border-brand-50
//     21x  rounded-xl  shadow-sm
//     21x  rounded-xl  border border-brand-100
//     12x  rounded-xl  border border-neutral-100
//
// Three radii (12px / 16px / 24px) and three border colours, chosen ad
// hoc, for the same object. The Card component existed and eleven places
// used it.
//
// RADIUS: standardised on rounded-xl (12px). Two reasons, and it is a
// visible decision so it is stated rather than buried -- rounded-xl is
// already the most common radius in the codebase (111 uses across its
// variants against 86 for rounded-3xl), and 24px reads as a consumer app
// rather than as accounting software. QuickBooks sits nearer 8-12px.
// Because it is a token now, changing this back is one edit here.
export const SURFACE = {
  // The default: a panel on the page background.
  card:   "bg-white rounded-xl border border-neutral-200",
  // A card that should lift off the page -- dashboard tiles, summaries.
  raised: "bg-white rounded-xl border border-neutral-200 shadow-card",
  // A recessed area INSIDE a card: a filter strip, a nested summary.
  inset:  "bg-neutral-50 rounded-xl border border-neutral-100",
  // Floating above everything: menus, popovers, dialogs.
  overlay: "bg-white rounded-xl border border-neutral-200 shadow-lg",
};

export function Card({ className = "", padding = "p-5", variant = "card", children, ...props }) {
  return (
    <div className={`${SURFACE[variant] || SURFACE.card} ${padding} ${className}`} {...props}>
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
  // Fall back to the first option's text as the accessible name.
  //
  // axe reported critical select-name failures on ten routes: filter
  // dropdowns are rendered bare, with their meaning carried only by the
  // selected option, so a screen reader announces "combo box" and
  // nothing else. The first option is almost always the "All …" label
  // that names the filter ("All Status", "All Types", "All Cities"),
  // which is exactly the name a user needs. An explicit aria-label
  // always wins.
  let derived;
  if (!props["aria-label"] && !props["aria-labelledby"]) {
    const first = React.Children.toArray(children).find(c => c && c.type === "option");
    const txt = first && typeof first.props?.children === "string" ? first.props.children.trim() : "";
    if (txt) derived = txt;
  }
  return (
    <select className={`${base}${widthCls} ${className}`} aria-label={derived} {...props}>
      {children}
    </select>
  );
}

export function Textarea({ className = "", rows = 3, size = "md", ...props }) {
  const base = inputBase(size, /\bw-/.test(className));
  return <textarea className={`${base} ${className}`} rows={rows} maxLength={props.maxLength || 5000} {...props} />;
}

// ---- FORM FIELD (label + input wrapper) ----
export function FormField({ label, required, className = "", size = "md", children }) {
  const labelCls = size === "sm"
    ? "text-2xs font-medium text-neutral-500 uppercase tracking-wider block mb-1"
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
// `size="section"` is the same header one step down, for a sub-page inside
// a section -- Chart of Accounts, Journal Entries, Reports and Bank
// Transactions all sit under Accounting rather than being top-level pages.
// Six of those had hand-written their own title/subtitle/actions row at
// text-lg, which is why they drifted from each other and from this.
const HEADER_SIZE = {
  page:    { wrap: "mb-5", title: "text-xl md:text-2xl", sub: "text-xs" },
  section: { wrap: "mb-4", title: "text-lg",             sub: "text-sm" },
};
export function PageHeader({ title, subtitle, children, size = "page" }) {
  const z = HEADER_SIZE[size] || HEADER_SIZE.page;
  return (
    <div className={`flex flex-col md:flex-row md:items-center justify-between gap-2 ${z.wrap}`}>
      <div>
        <h2 className={`${z.title} font-display font-bold text-neutral-800`}>{title}</h2>
        {subtitle && <p className={`${z.sub} text-neutral-400 mt-0.5`}>{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

// ---- SECTION TITLE (within a page) ----
export function SectionTitle({ children, className = "" }) {
  return <h3 className={`font-display font-bold text-neutral-700 text-sm mb-3 uppercase tracking-wide ${className}`}>{children}</h3>;
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
// Tabs.
//
// This component existed and NOTHING used it, because it rendered filled
// pills while every tab bar in the app is an UNDERLINE bar -- which is
// also what QuickBooks uses. So eleven pages each hand-wrote the same
// `border-b-2` button and drifted: px-3 vs px-4 vs px-5, py-1.5 vs py-2 vs
// py-3, text-xs vs text-sm, and only some of them with a hover state.
//
// `tabs` takes either [id, label] pairs or { id, label, icon, count }
// objects, because several bars show an icon and several append a count
// ("Expiring (3)") -- both of which had been spelled into the label by
// hand at the call site.
const TAB_SIZE = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-4 py-3 text-sm",
};
export function TabBar({ tabs, active, onChange, size = "md", variant = "underline", className = "" }) {
  const pad = TAB_SIZE[size] || TAB_SIZE.md;
  const items = tabs.map(t => (Array.isArray(t) ? { id: t[0], label: t[1] } : t));
  const wrap = variant === "pill"
    ? "flex gap-1 overflow-x-auto"
    : "flex gap-1 overflow-x-auto border-b border-neutral-200";
  return (
    <div className={`${wrap} ${className}`} role="tablist">
      {items.map(t => {
        const on = active === t.id;
        const look = variant === "pill"
          ? `rounded-lg ${on ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`
          // -mb-px pulls the active underline onto the container's border
          // so the two read as one line rather than stacking into two.
          : `border-b-2 -mb-px ${on ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-600"}`;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`${pad} font-medium whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${look} ${FOCUS_RING}`}>
            {t.icon && <span className="material-icons-outlined text-base">{t.icon}</span>}
            {t.label}
            {t.count != null && <span className="text-2xs text-neutral-400">({t.count})</span>}
          </button>
        );
      })}
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
          <div className="text-xl font-display font-bold text-neutral-800">{value}</div>
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
              <div className="px-3 py-1 text-2xs font-bold text-neutral-400 uppercase tracking-wider bg-neutral-50 sticky top-0">{g.type}</div>
              {g.items.map(a => {
                const idx = flatItems.indexOf(a);
                return (
                  <button type="button" key={a.id} data-idx={idx}
                    onMouseDown={(e) => { e.preventDefault(); select(a.id); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-brand-50 flex items-center gap-1 ${highlighted === idx ? "bg-brand-50 text-brand-700" : "text-neutral-700"} ${a.id === value ? "font-semibold" : ""}`}>
                    <span className="text-neutral-400 w-10 shrink-0 tnum">{a.code || "•"}</span>
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
// Accent palette follows the module's visual identity: brand (default),
// positive (Accounting module's green theme), dark (neutral-800 active).
export function FilterPill({ active, onClick, tone = "brand", children, className = "" }) {
  const activeTones = {
    brand:    "bg-brand-600 text-white",
    positive: "bg-positive-600 text-white border-positive-600",
    dark:     "bg-neutral-800 text-white border-neutral-800",
    notice:   "bg-notice-500 text-white",
    "positive-fill": "bg-positive-500 text-white",
    "danger-fill":   "bg-danger-500 text-white",
  };
  const inactiveTones = {
    brand:    "bg-neutral-100 text-neutral-600 hover:bg-neutral-200",
    positive: "bg-white text-neutral-500 border border-neutral-200 hover:border-positive-300",
    dark:     "bg-white text-neutral-400 border border-brand-100",
    notice:   "bg-white text-notice-700 border border-notice-200",
    "positive-fill": "bg-neutral-200 text-neutral-500 hover:bg-neutral-300",
    "danger-fill":   "bg-neutral-200 text-neutral-500 hover:bg-neutral-300",
  };
  const cls = active ? activeTones[tone] || activeTones.brand : inactiveTones[tone] || inactiveTones.brand;
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${cls} ${className}`}>
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

// ---- SWITCH ----
// An on/off toggle.
//
// Three of these were hand-written -- dark mode in Admin, a notification
// rule in AdminNotificationRules, a notification setting in Notifications
// -- and all three drifted: w-10 h-5 vs w-11 h-6, left-5 vs translate-x-5
// for the knob, and three different "on" colours (brand-600, positive-500,
// success-500). Only one of the three had an aria-label, and none was
// reachable as a real control: a <button> with no role and no aria-checked
// reads to a screen reader as an unlabelled button, not a switch.
const SWITCH_SIZE = {
  sm: { track: "w-10 h-5", knob: "w-4 h-4", on: "left-5",   off: "left-0.5" },
  md: { track: "w-11 h-6", knob: "w-5 h-5", on: "left-5.5", off: "left-0.5" },
};
const SWITCH_TONE = {
  brand:    "bg-brand-600",
  success:  "bg-success-500",
  positive: "bg-positive-500",
};
export function Switch({ checked, onChange, label, size = "sm", tone = "success", disabled, className = "" }) {
  const z = SWITCH_SIZE[size] || SWITCH_SIZE.sm;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange && onChange(!checked)}
      className={`relative shrink-0 rounded-full transition-colors ${z.track} ` +
        `${checked ? (SWITCH_TONE[tone] || SWITCH_TONE.success) : "bg-neutral-300"} ` +
        `disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING} ${className}`}
    >
      <span className={`absolute top-0.5 bg-white rounded-full shadow transition-all ${z.knob} ${checked ? z.on : z.off}`} />
    </button>
  );
}

// ---- SEARCH TRIGGER ----
// The visible entry point to the command palette.
//
// The palette already existed and was good, but it was reachable ONLY by
// Cmd/Ctrl-K -- nothing on screen said so, so for anyone who had not been
// told, the app had no search. QuickBooks puts a search box in the top bar
// and that is where people look for it.
//
// It is a BUTTON that looks like a text field, not a real input. The
// palette owns the query, the filtering and the keyboard handling; a
// second input here would either duplicate all of that or have to forward
// every keystroke into it. Looking like a field is the affordance; being
// one would be a second implementation.
export function SearchTrigger({ onOpen, hint = "K", placeholder = "Search or jump to…", className = "" }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${placeholder} (keyboard shortcut ${hint})`}
      className={"group flex items-center gap-2 w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-left " +
        "hover:border-brand-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 " +
        "focus-visible:ring-offset-1 transition-colors " + className}
    >
      <span className="material-icons-outlined text-base text-neutral-400 group-hover:text-brand-500">search</span>
      <span className="flex-1 truncate text-xs text-neutral-400">{placeholder}</span>
      <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-white px-1.5 py-0.5 text-2xs font-semibold text-neutral-400">
        {hint}
      </kbd>
    </button>
  );
}

// ---- COMPANY SCOPE ----
// The active company id, provided once at the app root.
//
// Shareable/new-tab links have to name their company, because the app
// strips ?company= from the address bar immediately after selecting one --
// so by the time a user cmd-clicks a figure there is nothing left in the
// URL to copy forward. The alternative was threading companyId through all
// fifteen LedgerLink call sites, where forgetting one produces a link that
// works for a single-company user and dumps a multi-company user at the
// company selector. A context cannot be forgotten at a call site.
export const CompanyScope = React.createContext(null);
export function useCompanyScope() { return React.useContext(CompanyScope); }

// ---- DRILL LINK ----
// A figure or label that drills through to its detail. QuickBooks renders
// these as ordinary text and only reveals the link on hover, which is what
// keeps a report reading as a statement rather than as a page of hyperlinks.
//
// It went the other way first -- brand colour plus a permanent dotted
// underline -- because nothing had marked the totals as clickable. That
// over-corrected: every account name and every amount in the Balance Sheet
// came out blue and underlined. Sahil: "unneccesary underlines and colours
// coding in the reports". Discoverability now rides on the cursor and the
// hover, as it does in QuickBooks.
//
// Every drillable figure in the app resolves its affordance from here, so
// this constant is the only place the decision lives.
export const DRILL_LINK =
  "text-inherit no-underline hover:text-brand-700 hover:underline hover:decoration-solid underline-offset-2 cursor-pointer rounded " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1";

// ---- TEXT LINK ----
// Underline-on-hover button that mirrors the common `text-xs text-COLOR-600
// hover:underline` pattern used for inline row actions (Edit / Delete /
// Report). Not a routed <a> — purely a click handler with link visuals.
export function TextLink({ tone = "brand", size = "xs", underline = true, className = "", children, ...props }) {
  const tones = {
    brand:    "text-brand-600 hover:text-brand-700",
    danger:   "text-danger-500 hover:text-danger-700",
    neutral:  "text-neutral-500 hover:text-neutral-700",
    success:  "text-success-600 hover:text-success-700",
    positive: "text-positive-600 hover:text-positive-700",
    warn:     "text-warn-600 hover:text-warn-700",
    notice:   "text-notice-500 hover:text-notice-700",
    info:     "text-info-600 hover:text-info-700",
    highlight:"text-highlight-600 hover:text-highlight-700",
    accent:   "text-accent-600 hover:text-accent-800",
    subtle:   "text-subtle-500 hover:text-subtle-700",
  };
  const sizes = { xs: "text-xs", sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-xl" };
  return (
    <button className={`${tones[tone] || tones.brand} ${sizes[size] || sizes.xs}${underline ? " hover:underline" : ""} ${FOCUS_RING} rounded ${className}`} {...props}>
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

// Mouse affordance for a whole card or row. Returns ONLY onClick --
// deliberately no role and no tabIndex.
//
// The first version of this added role="button" + tabIndex to the card
// container. That is invalid when the card contains its own buttons,
// links or checkboxes: a widget role may not contain other widgets, and
// screen readers stop exposing the inner controls. axe caught it as
// nested-interactive across 73 tenant cards. The keyboard path belongs
// on ONE real control inside the card -- see CardOpenButton.
export function clickable(onActivate) {
  return { onClick: onActivate };
}

// The real, focusable control inside a clickable card or row. Render the
// record's primary label through this so keyboard and screen-reader
// users get exactly one correctly-named way in, without the container
// swallowing everything else.
export function CardOpenButton({ onActivate, label, className = "", children }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onActivate(e); }}
      className={"text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + className}
    >{children}</button>
  );
}

// For LEAF clickable elements only -- a drop zone, an "add" tile, a
// badge -- i.e. ones with no interactive descendants. Do NOT put this on
// a card or row that contains buttons or links; role="button" there is
// nested-interactive and hides the inner controls from assistive tech.
// Spread alongside the existing onClick; it forwards Enter/Space.
//   <div {...keyboardActivate} onClick={() => ...}>
export const keyboardActivate = {
  role: "button",
  tabIndex: 0,
  onKeyDown: (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    if (e.target !== e.currentTarget) return; // inner controls keep their own keys
    e.preventDefault();
    e.currentTarget.click();
  },
};

// ============ DATA TABLE ============
// One table, so 62 of them stop each inventing their own.
//
// The audit found 62 hand-rolled <table>s across 15 files, with 9
// different header treatments and 24 distinct cell paddings. That
// inconsistency is what reads as unpolished -- two tables side by side in
// the same product disagreeing about what a column heading looks like.
//
// DENSITY LIVES HERE AND NOWHERE ELSE. Every padding below is a constant
// in this file, so changing row height is one edit rather than 24.
const TD = {
  normal:  "px-4 py-2.5",
  compact: "px-3 py-1.5",
};
const TH = {
  normal:  "px-4 py-2.5",
  compact: "px-3 py-1.5",
};
const ALIGN = { left: "text-left", right: "text-right", center: "text-center" };

// A column is { key, label, align, width, render, className, thClassName }.
// `render(row, index)` overrides the default cell, which is row[key].
// `align: "right"` also applies tabular figures, since a right-aligned
// column is nearly always numeric and digits must line up.
export function DataTable({
  columns = [],
  rows = [],
  rowKey,
  onRowClick,
  groups = null,        // [{ key, label, rows, footer }] -- renders one tbody each
  footer = null,        // [{ label, cells:[], strong }] -- total rows
  empty = "Nothing to show",
  loading = false,
  density = "normal",
  stickyHeader = false,
  // Some tables are deliberately header-less -- a journal entry's lines
  // inside a detail panel, a mini transaction list. Rendering a header
  // there would ADD a row that was never in the original.
  hideHeader = false,
  // Master-detail: an extra full-width row under a row, for the expanded
  // panel pattern -- click a bank transaction and its matching and
  // posting controls open beneath it. Return null for rows that are not
  // expanded. Without this in the primitive, every such table stays
  // hand-rolled, and flat-migrating one silently deleted 257 lines of
  // panel markup.
  expandedRow = null,
  // A first column pinned while the rest scrolls, for reports with one
  // column per property.
  stickyFirstColumn = false,
  // The mirror of stickyFirstColumn, for a crosstab whose TOTAL column
  // must stay on screen. The P&L by Property matrix has one column per
  // property; with forty of them an unpinned total is off-screen, which
  // reads as "this report has no totals".
  stickyLastColumn = false,
  // Per-row DOM attributes, as rowAttrs(row, index) => object. Keyboard
  // navigation needs to find a row by index from document.activeElement,
  // which needs a real attribute on the <tr>; the JE line editor carried
  // data-je-line={i} for exactly that and lost it when it was flat-migrated
  // here, silently breaking every shortcut that walks lines.
  rowAttrs = null,
  // Per-row classes, as rowClassName(row, index). A row can be marked in
  // ways a column cannot express: Banking's keyboard cursor draws a
  // ring-2 ring-inset on the row it is on, and the expanded row gets a
  // tinted background. Both lived on the hand-rolled <tr> and were lost
  // when it was migrated -- the cursor became invisible.
  rowClassName = null,
  // Sorting lives in the primitive, not in a per-page SortTh. Pass
  // sort={{ key, dir }} plus onSort(key), and give a column `sort: true`
  // (it sorts by its own key) or `sort: "other_key"`.
  //
  // Tenants.js had its own SortTh, which is how its whole table got
  // destroyed: the migration tool scans for literal <th>, saw one (the
  // checkbox header) behind seven <SortTh> components, and emitted a
  // one-column table. Every page that grows a sortable header from here
  // on gets it from the same place, so there is nothing bespoke left to
  // misread. It also puts aria-sort on the <th>, where it belongs --
  // SortTh had it on the inner <button>, where assistive tech does not
  // look for it.
  sort = null,
  onSort = null,
  scroll = true,
  className = "",
  ariaLabel,
}) {
  const td = TD[density] || TD.normal;
  const th = TH[density] || TH.normal;
  // `sort: true` means "sort by my own key"; a string names another field.
  const sortKeyOf = c => (c.sort === true ? c.key : (typeof c.sort === "string" ? c.sort : null));
  const cols = columns.length || 1;
  const keyOf = (r, i) => (rowKey ? rowKey(r, i) : (r && r.id != null ? r.id : i));

  const cell = (col, row, i) => {
    const v = col.render ? col.render(row, i) : (row ? row[col.key] : null);
    return (
      <td
        key={col.key}
        className={[
          td,
          stickyFirstColumn && col === columns[0] ? "sticky left-0 z-10 bg-white" : "",
          stickyLastColumn && col === columns[columns.length - 1] ? "sticky right-0 z-10 bg-white" : "",
          ALIGN[col.align] || ALIGN.left,
          col.align === "right" ? "tnum" : "",
          // A className may be a FUNCTION of the row. Several tables colour
          // a cell by its own value -- an overdue balance in red, a
          // negative figure in danger -- and forcing those to a static
          // string would silently drop the conditional styling.
          (typeof col.className === "function" ? col.className(row, i) : col.className) || "",
        ].filter(Boolean).join(" ")}
        style={col.width ? { width: col.width } : undefined}
      >
        {v}
      </td>
    );
  };

  const bodyRows = (list) =>
    list.flatMap((row, i) => {
      const expanded = expandedRow ? expandedRow(row, i) : null;
      const main = (
        <tr
          key={keyOf(row, i)}
          {...(rowAttrs ? rowAttrs(row, i) : null)}
          onClick={onRowClick ? () => onRowClick(row, i) : undefined}
          className={[
            "border-t border-neutral-100",
            onRowClick ? "cursor-pointer hover:bg-brand-50/40 transition-colors" : "",
            (rowClassName ? rowClassName(row, i) : "") || "",
          ].filter(Boolean).join(" ")}
        >
          {columns.map(c => cell(c, row, i))}
        </tr>
      );
      // The detail row spans every column, computed here rather than by
      // the caller -- a hand-written colSpan is what put a 9-column
      // header over 8-column rows in the ledger.
      return expanded
        ? [main, <tr key={String(keyOf(row, i)) + "-detail"}><td colSpan={cols} className="p-0">{expanded}</td></tr>]
        : [main];
    });

  // A footer row gives cells for the LAST n columns and spans the rest, so
  // a total lines up under its column without every caller counting
  // colSpans by hand -- the mistake that put a 9-column header over
  // 8-column rows in the ledger.
  const footerRow = (f, i) => {
    const given = (f.cells || []).length;
    const span = Math.max(cols - given, 1);
    return (
      // f.className lets a caller keep an emphasis the primitive does not
      // have a name for -- the P&L matrix's bottom line was font-black over
      // a border-neutral-800 rule, and flattening every total row to one
      // weight would have lost the distinction between a section subtotal
      // and the report's answer.
      <tr key={(typeof f.label === "string" ? f.label : null) || i}
          className={(f.className || "border-t-2 border-neutral-300 " + (f.strong ? "font-bold" : "font-semibold"))}>
        <td className={[td, ALIGN[columns[0] && columns[0].align] || ALIGN.left,
          stickyFirstColumn ? "sticky left-0 z-10 bg-neutral-100" : ""].filter(Boolean).join(" ")} colSpan={span}>{f.label}</td>
        {(f.cells || []).map((c, ci) => {
          const col = columns[cols - given + ci] || {};
          return (
            <td key={ci} className={[td, ALIGN[col.align] || ALIGN.right, "tnum",
              // Without this a pinned column lost its pin on every total
              // row -- the totals scrolled away while the data stayed put.
              stickyLastColumn && col === columns[columns.length - 1] ? "sticky right-0 z-10 bg-neutral-100" : "",
            ].filter(Boolean).join(" ")}>
              {c}
            </td>
          );
        })}
      </tr>
    );
  };

  const table = (
    <table className={"w-full text-sm border-collapse " + className} aria-label={ariaLabel}>
      {!hideHeader && (
      <thead className={"bg-neutral-50 text-xs text-neutral-500 uppercase tracking-wide " + (stickyHeader ? "sticky top-0 z-10" : "")}>
        <tr>
          {columns.map(c => (
            <th
              key={c.key}
              scope="col"
              className={[th, ALIGN[c.align] || ALIGN.left, "font-semibold",
                stickyFirstColumn && c === columns[0] ? "sticky left-0 z-20 bg-neutral-50" : "",
                stickyLastColumn && c === columns[columns.length - 1] ? "sticky right-0 z-20 bg-neutral-50" : "",
                c.thClassName || ""].filter(Boolean).join(" ")}
              style={c.width ? { width: c.width } : undefined}
              aria-sort={sortKeyOf(c) && sort && sort.key === sortKeyOf(c)
                ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
            >
              {sortKeyOf(c) && onSort ? (
                <button
                  type="button"
                  onClick={() => onSort(sortKeyOf(c))}
                  className="inline-flex items-center gap-1 uppercase hover:text-neutral-700"
                  aria-label={`Sort by ${c.label}`}
                >
                  {c.label}
                  {sort && sort.key === sortKeyOf(c) && (
                    <span className="material-icons-outlined text-sm leading-none">
                      {sort.dir === "asc" ? "arrow_upward" : "arrow_downward"}
                    </span>
                  )}
                </button>
              ) : c.label}
            </th>
          ))}
        </tr>
      </thead>
      )}

      {loading ? (
        <tbody><tr><td colSpan={cols} className={td + " text-center text-neutral-400 py-8"}>Loading…</td></tr></tbody>
      ) : groups ? (
        <>
          {groups.map(g => (
            <tbody key={g.key}>
              {g.label && (
                <tr className="bg-neutral-100/80">
                  <td colSpan={cols} className={td + " text-xs font-bold text-neutral-700 border-t-2 border-neutral-300" + (stickyFirstColumn ? " sticky left-0 z-10 bg-neutral-100" : "")}>{g.label}</td>
                </tr>
              )}
              {bodyRows(g.rows || [])}
              {/* A section can end with more than one total: the P&L
                  matrix follows "Total COGS" with "Gross Profit", and
                  "Total for Expenses" with "Net Operating Income". */}
              {g.footer && (Array.isArray(g.footer) ? g.footer : [g.footer]).map(footerRow)}
            </tbody>
          ))}
          {footer && <tbody>{footer.map(footerRow)}</tbody>}
          {groups.every(g => !(g.rows || []).length) && (
            <tbody><tr><td colSpan={cols} className={td + " text-center text-neutral-400 py-8"}>{empty}</td></tr></tbody>
          )}
        </>
      ) : (
        <tbody>
          {rows.length ? bodyRows(rows) : (
            <tr><td colSpan={cols} className={td + " text-center text-neutral-400 py-8"}>{empty}</td></tr>
          )}
          {footer && rows.length > 0 && footer.map(footerRow)}
        </tbody>
      )}
    </table>
  );

  // Wide content scrolls inside its own container so the page body never
  // scrolls sideways.
  return scroll ? <div className="overflow-x-auto">{table}</div> : table;
}
