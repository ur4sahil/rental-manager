// The login form must never hang.
//
// handleLogin did this:
//
//   setLoading(true);
//   const { error } = await supabase.auth.signInWithPassword(...);
//   ...
//   setLoading(false);
//
// supabase-js returns { error } for anything the SERVER answered, but a
// request that never reached the server -- offline, DNS, a blocked or
// aborted fetch -- REJECTS instead. Nothing caught that, so the throw
// escaped, setLoading(false) never ran, and the button sat on
// "Please wait..." for ever with no message.
//
// From the outside that is indistinguishable from a broken site, which is
// exactly how it presented: a TypeError: Failed to fetch in the console, a
// spinner that never ends, and a page still showing Sign In. It took an
// aborted auth POST on the test site to surface it, but the trigger does not
// matter -- any failed request does this to any user.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const src = fs.readFileSync(path.join(__dirname, "..", "src", "components", "LoginPage.js"), "utf8");

console.log("\n=== LOGIN RESILIENCE ===\n");

// Every handler that starts a spinner must be able to stop it.
const handlers = ["handleLogin", "handleForgotPassword", "handleSignup"];
for (const h of handlers) {
  const start = src.indexOf(`const ${h} = async`);
  assert(`${h} exists`, start > -1);
  if (start < 0) continue;
  // Body runs to the next top-level handler or the render.
  const rest = src.slice(start);
  const end = Math.min(...["\n  const handle", "\n  const userTypeLabels"]
    .map(m => { const i = rest.indexOf(m, 10); return i === -1 ? Infinity : i; }));
  const body = rest.slice(0, end === Infinity ? 4000 : end);

  assert(`${h} sets loading`, /setLoading\(true\)/.test(body));
  assert(`${h} clears loading in a finally`,
    /\} finally \{[\s\S]{0,120}setLoading\(false\)/.test(body),
    "a throw between true and false leaves the button stuck for ever");
  assert(`${h} catches a thrown request and shows it`,
    /\} catch \([a-z]+\) \{[\s\S]{0,160}setError\(describeThrow\(/.test(body),
    "an unreported failure is worse than a reported one: nothing on screen changes");
}

// The message must be actionable, not the raw exception.
assert("a network failure is explained in plain words",
  /failed to fetch\|networkerror\|load failed\|aborted/i.test(src)
  && /Could not reach the server/.test(src),
  '"TypeError: Failed to fetch" tells a property manager nothing');

assert("an unrecognised error still produces some message",
  /return msg \|\| "Something went wrong/.test(src),
  "an empty string in setError renders a blank error box");

// The captcha must be reset on the throw path too, or a retry is refused
// by a token that has already been spent.
const loginBody = src.slice(src.indexOf("const handleLogin = async"), src.indexOf("const handleForgotPassword"));
assert("the captcha is reset when the request throws",
  /\} catch \([a-z]+\) \{[\s\S]{0,120}resetCaptcha\(\)/.test(loginBody),
  "hCaptcha tokens are single-use; retrying with a spent one fails again");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
