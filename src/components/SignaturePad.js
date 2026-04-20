import React, { useRef, useState } from "react";
import { printTheme } from "../utils/theme";

// Reusable signature capture: draw OR type mode + consent checkbox.
// onSubmit receives: { signatureData, signingMethod, consentText }
//   signatureData = PNG data URL (draw) or "typed:<name>|ts:<iso>" (type)
// Used by both the lease signing modal and the public /sign/:token page
// so audit semantics stay identical.
export default function SignaturePad({
  signerName = "",
  signerLabel = "",
  consentText = "I agree that my electronic signature is the legal equivalent of my manual/handwritten signature and I consent to be legally bound by this document.",
  submitLabel = "Apply Signature",
  submitting = false,
  onSubmit,
}) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [signMethod, setSignMethod] = useState("draw");
  const [typedName, setTypedName] = useState(signerName || "");
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [localError, setLocalError] = useState("");

  function startDraw(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsDrawing(true);
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function draw(e) {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = printTheme.signatureInk;
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function endDraw() { setIsDrawing(false); }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function handleSubmit() {
    setLocalError("");
    if (!consentAgreed) {
      setLocalError("You must agree to the electronic signature consent before signing.");
      return;
    }
    let signatureData = "";
    if (signMethod === "draw") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hasContent = pixels.some((v, i) => i % 4 === 3 && v > 0);
      if (!hasContent) { setLocalError("Please draw your signature first."); return; }
      signatureData = canvas.toDataURL("image/png");
    } else {
      if (!typedName.trim()) { setLocalError("Please type your full legal name."); return; }
      signatureData = "typed:" + typedName.trim() + "|ts:" + new Date().toISOString();
    }
    onSubmit({ signatureData, signingMethod: signMethod, consentText, signerName: typedName.trim() || signerName });
  }

  return (
    <div className="border border-brand-100 rounded-2xl p-4 bg-white">
      {signerLabel && <div className="text-sm font-semibold text-neutral-700 mb-2">Signing as: {signerLabel}{signerName ? " — " + signerName : ""}</div>}

      <div className="flex gap-2 mb-3">
        <button type="button" onClick={() => { setSignMethod("draw"); setLocalError(""); }} className={"text-xs px-3 py-1.5 rounded-lg font-medium " + (signMethod === "draw" ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200")}>Draw Signature</button>
        <button type="button" onClick={() => { setSignMethod("type"); setLocalError(""); }} className={"text-xs px-3 py-1.5 rounded-lg font-medium " + (signMethod === "type" ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200")}>Type Name</button>
      </div>

      {signMethod === "draw" ? (
        <div>
          <div className="border-2 border-dashed border-brand-200 rounded-lg bg-white relative mb-2">
            <canvas
              ref={canvasRef}
              width={600}
              height={160}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
              className="w-full cursor-crosshair"
              style={{ touchAction: "none" }}
            />
            <div className="absolute bottom-1 left-3 text-xs text-neutral-300 pointer-events-none">Sign above this line</div>
          </div>
          <button type="button" onClick={clearCanvas} className="text-xs text-neutral-500 hover:underline">Clear</button>
        </div>
      ) : (
        <div>
          <input
            value={typedName}
            onChange={e => setTypedName(e.target.value)}
            placeholder="Type your full legal name"
            className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm mb-1"
          />
          {typedName && <div className="text-2xl text-brand-800 italic font-serif py-3 px-3 bg-brand-50/40 rounded-lg">{typedName}</div>}
        </div>
      )}

      <label className="flex items-start gap-2 mt-4 bg-warn-50 rounded-lg p-3 cursor-pointer">
        <input type="checkbox" checked={consentAgreed} onChange={e => setConsentAgreed(e.target.checked)} className="mt-0.5 accent-brand-600" />
        <span className="text-xs text-neutral-600 leading-relaxed">{consentText}</span>
      </label>

      {localError && <div className="mt-3 text-xs text-danger-600 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2">{localError}</div>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || !consentAgreed}
        className={"w-full mt-3 py-2.5 rounded-xl text-white font-semibold text-sm transition-colors " + (submitting || !consentAgreed ? "bg-neutral-400 cursor-not-allowed" : "bg-brand-600 hover:bg-brand-700")}
      >
        {submitting ? "Signing…" : !consentAgreed ? "Agree to the terms above to sign" : submitLabel}
      </button>
    </div>
  );
}
