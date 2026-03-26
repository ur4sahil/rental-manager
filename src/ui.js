import React from "react";

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
  danger:    "text-red-600 border border-red-200 hover:bg-red-50 bg-white",
  "danger-fill": "bg-red-600 text-white hover:bg-red-700",
  success:   "text-emerald-600 border border-emerald-200 hover:bg-emerald-50 bg-white",
  "success-fill": "bg-emerald-600 text-white hover:bg-emerald-700",
  ghost:     "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
  purple:    "text-purple-600 border border-purple-200 hover:bg-purple-50 bg-white",
  amber:     "text-amber-600 border border-amber-200 hover:bg-amber-50 bg-white",
  slate:     "text-slate-600 bg-slate-100 hover:bg-slate-200",
};
const BTN_SIZES = {
  xs: "text-xs px-2 py-1 rounded-lg gap-1",
  sm: "text-xs px-3 py-1.5 rounded-lg gap-1.5",
  md: "text-sm px-4 py-2 rounded-2xl gap-2",
  lg: "text-sm px-5 py-2.5 rounded-2xl gap-2",
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
    <button className={`w-8 h-8 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 transition-colors ${className}`} title={title} {...props}>
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

// ---- INPUT ----
const INPUT_BASE = "border border-brand-100 rounded-2xl px-3 py-2 text-sm w-full focus:border-brand-300 focus:outline-none transition-colors";

export function Input({ className = "", ...props }) {
  // Auto-apply sensible defaults by type
  const defaults = {};
  if (props.type === "date") { defaults.min = props.min || "2000-01-01"; defaults.max = props.max || "2099-12-31"; }
  else if (props.type === "email") { defaults.maxLength = props.maxLength || 254; }
  else if (props.type === "tel") { defaults.maxLength = props.maxLength || 14; }
  else if (props.type === "number") { defaults.step = props.step || "any"; }
  else if (props.type === "text" && !props.maxLength) { defaults.maxLength = 200; }
  return <input className={`${INPUT_BASE} ${className}`} {...defaults} {...props} />;
}

// ---- SELECT ----
export function Select({ className = "", children, ...props }) {
  return <select className={`${INPUT_BASE} ${className}`} {...props}>{children}</select>;
}

// ---- TEXTAREA ----
export function Textarea({ className = "", rows = 3, ...props }) {
  return <textarea className={`${INPUT_BASE} ${className}`} rows={rows} maxLength={props.maxLength || 5000} {...props} />;
}

// ---- FORM FIELD (label + input wrapper) ----
export function FormField({ label, required, className = "", children }) {
  return (
    <div className={className}>
      {label && (
        <label className="text-xs font-medium text-slate-500 uppercase tracking-widest block mb-1">
          {label} {required && "*"}
        </label>
      )}
      {children}
    </div>
  );
}

// ---- BADGE ----
const BADGE_COLORS = {
  green:  "bg-emerald-50 text-emerald-700 border-emerald-200",
  red:    "bg-red-50 text-red-700 border-red-200",
  yellow: "bg-amber-50 text-amber-700 border-amber-200",
  blue:   "bg-blue-50 text-blue-700 border-blue-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
  gray:   "bg-slate-50 text-slate-600 border-slate-200",
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
        <h2 className="text-xl md:text-2xl font-manrope font-bold text-slate-800">{title}</h2>
        {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

// ---- SECTION TITLE (within a page) ----
export function SectionTitle({ children, className = "" }) {
  return <h3 className={`font-manrope font-bold text-slate-700 text-sm mb-3 uppercase tracking-wide ${className}`}>{children}</h3>;
}

// ---- EMPTY STATE ----
export function EmptyState({ icon = "inbox", title, subtitle }) {
  return (
    <div className="text-center py-16 text-slate-400">
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
          className={`${sizeClass} font-medium rounded-lg whitespace-nowrap transition-colors ${active === id ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- STAT CARD (dashboard) ----
export function StatCard({ label, value, icon, color = "indigo", trend }) {
  const bgMap = { indigo: "bg-brand-50", green: "bg-emerald-50", red: "bg-red-50", amber: "bg-amber-50", purple: "bg-purple-50" };
  const textMap = { indigo: "text-brand-600", green: "text-emerald-600", red: "text-red-600", amber: "text-amber-600", purple: "text-purple-600" };
  return (
    <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-5">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 ${bgMap[color]} rounded-2xl flex items-center justify-center`}>
          <span className={`material-icons-outlined ${textMap[color]}`}>{icon}</span>
        </div>
        <div>
          <div className="text-xs text-slate-400 font-medium">{label}</div>
          <div className="text-xl font-manrope font-bold text-slate-800">{value}</div>
          {trend && <div className="text-xs text-emerald-600 font-medium">{trend}</div>}
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
        <button onClick={onDeselect} className="text-xs text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100">Deselect</button>
      </div>
    </div>
  );
}

// ---- FILTER PILL ----
export function FilterPill({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${active ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
      {children}
    </button>
  );
}
