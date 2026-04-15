import React, { useState } from "react";
import { supabase } from "../supabase";
import { Input, PageHeader } from "../ui";
import { PM_ERRORS, pmError } from "../utils/errors";

// ============ LOGIN / SIGNUP PAGE (Role-Aware) ============
function LoginPage({ onLogin, onBack, initialMode = "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState(initialMode); // "login", "signup_pm", "signup_owner", "signup_tenant"
  const [signupSuccess, setSignupSuccess] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  const handleLogin = async () => {
  setLoading(true);
  setError("");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
  setError(error.message);
  } else {
  onLogin();
  }
  setLoading(false);
  };

  const handleSignup = async (userType) => {
  if (!email || !password) { setError("Email and password are required."); return; }
  if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
  if (!name.trim()) { setError("Name is required."); return; }
  setLoading(true);
  setError("");

  // For tenant signup: validate AND redeem invite code BEFORE creating auth account
  // This prevents orphaned auth accounts if redemption fails
  let tenantRedemption = null;
  if (userType === "tenant") {
  if (!inviteCode.trim()) { setError("Invite code is required."); setLoading(false); return; }
  // Validate invite code (but don't redeem yet)
  const { data: valResult, error: valErr } = await supabase.rpc("validate_invite_code", { p_code: inviteCode.trim().toUpperCase() });
  if (valErr || !valResult?.valid) { setError("Invalid or expired invite code."); setLoading(false); return; }
  }

  // Create auth account FIRST (before redeeming invite to prevent orphaned invites)
  const { data: signupData, error: signupErr } = await supabase.auth.signUp({
  email, password,
  options: { data: { name: name.trim(), user_type: userType } }
  });
  if (signupErr) { pmError("PM-1009", { raw: signupErr, context: "user signup" }); setError(PM_ERRORS["PM-1009"].message); setLoading(false); return; }

  // NOW redeem the invite (auth account exists, safe to consume)
  if (userType === "tenant" && inviteCode) {
  const { data: redeemResult, error: redeemErr } = await supabase.rpc("redeem_invite_code", {
  p_code: inviteCode.trim().toUpperCase(),
  p_email: email.toLowerCase(),
  p_name: name.trim(),
  });
  if (redeemErr || !redeemResult?.success) {
  setError("Account created but invite code failed: " + (redeemErr?.message || "already used") + ". Contact your property manager for a new invite.");
  setLoading(false);
  return;
  }
  tenantRedemption = redeemResult;
  }

  // For tenants: auto-join their company using the invite redemption data
  if (tenantRedemption?.company_id) {
  const { error: memErr } = await supabase.from("company_members").upsert([{
  company_id: tenantRedemption.company_id,
  user_email: email.toLowerCase(),
  user_name: name.trim(),
  role: "tenant",
  status: "active",  // Invite was redeemed — full access immediately
  invited_by: "invite_code",
  }], { onConflict: "company_id,user_email" });
  if (memErr) pmError("PM-1006", { raw: memErr, context: "auto-join from invite", silent: true });
  }

  // Save user_type to app_users
  const { error: appUserErr } = await supabase.from("app_users").insert([{
  email: email.toLowerCase(), name: name.trim(), role: userType === "tenant" ? "tenant" : userType === "owner" ? "owner" : "pm",
  user_type: userType,
  }]).select();
  if (appUserErr && !appUserErr.message.includes("duplicate")) { pmError("PM-1009", { raw: appUserErr, context: "app_users write", silent: true }); }

  setSignupSuccess(true);
  setLoading(false);
  };

  const userTypeLabels = {
  signup_pm: { title: "Property Manager Sign Up", subtitle: "Create your management account", color: "indigo", icon: "\u{1F3E2}" },
  signup_owner: { title: "Property Owner Sign Up", subtitle: "Create your owner account", color: "emerald", icon: "\u{1F3E0}" },
  signup_tenant: { title: "Tenant Sign Up", subtitle: "Join with your invite code", color: "amber", icon: "\u{1F511}" },
  };

  if (signupSuccess) {
  return (
  <div className="min-h-screen bg-gradient-to-br from-brand-50 to-white flex flex-col">
  <nav className="flex items-center justify-between px-8 py-4">
  <button onClick={onBack} className="text-xl font-bold text-brand-700">{"\u{1F3E1}"} PropManager</button>
  </nav>
  <div className="flex-1 flex items-center justify-center px-4">
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-8 w-full max-w-sm text-center">
  <div className="text-4xl mb-3">{"\u2705"}</div>
  <PageHeader title="Account Created!" />
  <p className="text-sm text-neutral-400 mb-4">Check your email for a confirmation link. Once confirmed, you can sign in.</p>
  <button onClick={() => { setSignupSuccess(false); setMode("login"); setError(""); }} className="bg-brand-600 text-white py-2.5 px-6 rounded-lg font-semibold text-sm hover:bg-brand-700">Back to Sign In</button>
  </div>
  </div>
  </div>
  );
  }

  const isSignup = mode.startsWith("signup_");
  const typeInfo = userTypeLabels[mode] || {};

  return (
  <div className="min-h-screen bg-gradient-to-br from-brand-50 to-white flex flex-col">
  <nav className="flex items-center justify-between px-8 py-4">
  <button onClick={onBack} className="text-xl font-bold text-brand-700">{"\u{1F3E1}"} PropManager</button>
  </nav>
  <div className="flex-1 flex items-center justify-center px-4">
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-8 w-full max-w-sm">
  {isSignup && (
  <div className="text-center mb-4">
  <span className="text-3xl">{typeInfo.icon}</span>
  <PageHeader title="{typeInfo.title}" />
  <p className="text-sm text-neutral-400">{typeInfo.subtitle}</p>
  </div>
  )}
  {!isSignup && (
  <>
  <PageHeader title="Welcome back" />
  <p className="text-sm text-neutral-400 mb-6">Sign in to your account</p>
  </>
  )}
  {error && <div className="bg-danger-50 text-danger-600 text-xs rounded-lg px-3 py-2 mb-4">{error}</div>}

  {isSignup && (
  <div className="mb-4">
  <label className="text-xs font-medium text-neutral-500 block mb-1">Full Name</label>
  <Input value={name} onChange={e => setName(e.target.value)} placeholder="John Smith" />
  </div>
  )}
  <div className="mb-4">
  <label className="text-xs font-medium text-neutral-500 block mb-1">Email</label>
  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
  </div>
  <div className="mb-4">
  <label className="text-xs font-medium text-neutral-500 block mb-1">Password</label>
  <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" onKeyDown={e => e.key === "Enter" && (isSignup ? handleSignup(mode.replace("signup_", "")) : handleLogin())} />
  </div>

  {mode === "signup_tenant" && (
  <div className="mb-4">
  <label className="text-xs font-medium text-neutral-500 block mb-1">Invite Code *</label>
  <Input value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} placeholder="e.g. TNT-38472916" className="bg-warn-50 font-mono tracking-wider" />
  <p className="text-xs text-neutral-400 mt-1">Check your invite email from your landlord or property manager</p>
  </div>
  )}

  <button onClick={isSignup ? () => handleSignup(mode.replace("signup_", "")) : handleLogin} disabled={loading} className={`w-full text-white py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50 ${isSignup ? (mode === "signup_pm" ? "bg-brand-600 hover:bg-brand-700" : mode === "signup_owner" ? "bg-success-600 hover:bg-success-700" : "bg-warn-600 hover:bg-warn-700") : "bg-brand-600 hover:bg-brand-700"}`}>
  {loading ? "Please wait..." : isSignup ? "Create Account" : "Sign In"}
  </button>

  <div className="text-center mt-4 space-y-2">
  {isSignup ? (
  <button onClick={() => { setMode("login"); setError(""); }} className="text-xs text-brand-600 hover:underline">Already have an account? Sign in</button>
  ) : (
  <button onClick={onBack} className="text-xs text-brand-600 hover:underline">Back to role selection</button>
  )}
  </div>
  </div>
  </div>
  </div>
  );
}

export { LoginPage };
