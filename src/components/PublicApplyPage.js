import React, { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { SURFACE } from "../ui";
import { fmtDate, fmtDateTime, formatCurrency } from "../utils/helpers";
import { APPLICATION_SECTIONS, APPLICATION_CERTIFICATION, validateApplication, cleanAnswers, isFieldShown } from "../utils/applicationForm";

// Public page at /apply/:token -- no account needed. An applicant fills in
// the rental application the company sent them and signs it by typing their
// name. Uses two anon-callable SECURITY DEFINER functions:
//   get_application_by_token(token)   what the link is for
//   submit_application(token, ...)    hand it in, once
// Nothing here can read anyone else's application: the token is the key.
const INPUT = "w-full border border-neutral-300 rounded-lg px-3 py-2.5 text-base bg-white focus:outline-none focus:border-brand-500";

export default function PublicApplyPage({ token }) {
  const [state, setState] = useState({ loading: true });
  const [answers, setAnswers] = useState({});
  const [signedName, setSignedName] = useState("");
  const [certified, setCertified] = useState(false);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let off = false;
    (async () => {
      const { data, error } = await supabase.rpc("get_application_by_token", { p_token: token });
      if (off) return;
      if (error) { setState({ error: "This application could not be loaded. Please check the link and try again." }); return; }
      if (data?.status === "submitted") { setState({ done: true, name: data.applicant_name, at: data.submitted_at }); return; }
      if (data?.error) {
        const msg = data.error === "expired" ? "This application link has expired. Please ask for a new one."
          : data.error === "withdrawn" ? "This application link has been replaced by a newer one. Please use the latest link you were sent."
          : "This application link is not valid.";
        setState({ error: msg });
        return;
      }
      setState({ info: data });
      setAnswers({ full_name: data.applicant_name || "", email: data.applicant_email || "" });
    })();
    return () => { off = true; };
  }, [token]);

  const set = (key, value) => { setAnswers(prev => ({ ...prev, [key]: value })); if (errors[key]) setErrors(prev => { const n = { ...prev }; delete n[key]; return n; }); };

  async function submit() {
    const check = validateApplication(answers, signedName, certified);
    setErrors(check.errors);
    if (!check.ok) {
      const el = document.getElementById("app-" + check.first);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setSubmitting(true);
    const { data, error } = await supabase.rpc("submit_application", {
      p_token: token, p_answers: cleanAnswers(answers), p_signed_name: signedName.trim(),
      p_consent_text: APPLICATION_CERTIFICATION, p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    });
    setSubmitting(false);
    if (error || data?.error) {
      setErrors({ _submit: data?.error === "already submitted or withdrawn" ? "This application has already been submitted." : "It could not be submitted. Please try again in a moment." });
      return;
    }
    setState({ done: true, name: signedName.trim(), at: data.submitted_at });
    window.scrollTo(0, 0);
  }

  const shell = (children) => (
    <div className="min-h-screen bg-neutral-50 py-8 px-4" style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div className={`max-w-2xl mx-auto ${SURFACE.raised} p-6 md:p-8`}>{children}</div>
    </div>
  );
  if (state.loading) return shell(<p className="text-neutral-500 text-center py-10">Loading…</p>);
  if (state.error) return shell(<><h1 className="text-xl font-bold text-neutral-800 mb-2">Rental application</h1><p className="text-neutral-600">{state.error}</p></>);
  if (state.done) return shell(<>
    <h1 className="text-xl font-bold text-neutral-800 mb-2">Thank you{state.name ? ", " + String(state.name).split(/\s+/)[0] : ""}</h1>
    <p className="text-neutral-600">Your application was received{state.at ? " on " + fmtDateTime(state.at) : ""}. You do not need to do anything else; the property manager will be in touch.</p>
  </>);

  const info = state.info;
  return shell(<>
    <h1 className="text-2xl font-bold text-neutral-800">Rental application</h1>
    <p className="text-neutral-600 mt-1">
      {info.company_name ? <>For <strong>{info.company_name}</strong>. </> : null}
      {info.property ? <>Home: <strong>{info.property}</strong>{info.rent ? ", " + formatCurrency(info.rent) + " a month" : ""}{info.lease_start ? ", from " + fmtDate(info.lease_start) : ""}.</> : null}
    </p>
    <p className="text-sm text-neutral-500 mt-2">It takes about ten minutes. We do not ask for your Social Security number or bank details. Each adult who will be on the lease fills in their own.</p>

    {APPLICATION_SECTIONS.map(section => (
      <section key={section.title} className="mt-7">
        <h2 className="text-base font-semibold text-neutral-800 border-b border-neutral-200 pb-1.5 mb-3">{section.title}</h2>
        <div className="space-y-4">
          {section.fields.filter(field => isFieldShown(field, answers)).map(field => {
            const id = "app-" + field.key, err = errors[field.key];
            const required = field.required || field.requiredWhenShown;
            return (
              <div key={field.key}>
                <label htmlFor={id} className="block text-sm font-medium text-neutral-700 mb-1">{field.label}{required ? <span className="text-danger-600"> *</span> : null}</label>
                {field.type === "textarea" ? (
                  <textarea id={id} rows={3} className={INPUT} value={answers[field.key] || ""} onChange={e => set(field.key, e.target.value)} aria-invalid={!!err} />
                ) : field.type === "yesno" ? (
                  <div id={id} className="flex gap-2" role="radiogroup" aria-label={field.label}>
                    {["yes", "no"].map(v => (
                      <button key={v} type="button" role="radio" aria-checked={answers[field.key] === v} onClick={() => set(field.key, v)}
                        className={"px-5 py-2.5 rounded-lg border text-base " + (answers[field.key] === v ? "border-brand-600 bg-brand-50 text-brand-700 font-semibold" : "border-neutral-300 bg-white text-neutral-700")}>{v === "yes" ? "Yes" : "No"}</button>
                    ))}
                  </div>
                ) : (
                  <input id={id} className={INPUT} type={field.type === "money" ? "text" : field.type} inputMode={field.type === "money" ? "decimal" : undefined}
                    autoComplete={field.key === "email" ? "email" : field.key === "phone" ? "tel" : field.key === "full_name" ? "name" : "off"}
                    value={answers[field.key] || ""} onChange={e => set(field.key, e.target.value)} aria-invalid={!!err} />
                )}
                {err && <p className="text-sm text-danger-600 mt-1">{err}</p>}
              </div>
            );
          })}
        </div>
      </section>
    ))}

    <section className="mt-8 bg-neutral-50 border border-neutral-200 rounded-xl p-4">
      <h2 className="text-base font-semibold text-neutral-800 mb-2">Sign and send</h2>
      <p className="text-sm text-neutral-600 mb-3">{APPLICATION_CERTIFICATION}</p>
      <label id="app-_certified" className="flex items-start gap-2 text-sm text-neutral-800 mb-3 cursor-pointer">
        <input type="checkbox" className="mt-1 w-4 h-4" checked={certified} onChange={e => { setCertified(e.target.checked); if (errors._certified) setErrors(p => { const n = { ...p }; delete n._certified; return n; }); }} />
        <span>I agree, and I am signing this application electronically.</span>
      </label>
      {errors._certified && <p className="text-sm text-danger-600 -mt-2 mb-2">{errors._certified}</p>}
      <label htmlFor="app-_signed" className="block text-sm font-medium text-neutral-700 mb-1">Type your full name to sign<span className="text-danger-600"> *</span></label>
      <input id="app-_signed" className={INPUT} autoComplete="name" value={signedName} onChange={e => { setSignedName(e.target.value); if (errors._signed) setErrors(p => { const n = { ...p }; delete n._signed; return n; }); }} />
      {errors._signed && <p className="text-sm text-danger-600 mt-1">{errors._signed}</p>}
      {errors._submit && <p className="text-sm text-danger-600 mt-3">{errors._submit}</p>}
      {Object.keys(errors).some(k => !k.startsWith("_")) && <p className="text-sm text-danger-600 mt-3">Some answers above still need attention.</p>}
      <button type="button" onClick={submit} disabled={submitting}
        className="mt-4 w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-semibold rounded-lg py-3 text-base">{submitting ? "Sending…" : "Submit application"}</button>
    </section>
  </>);
}
