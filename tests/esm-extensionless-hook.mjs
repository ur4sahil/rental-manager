// Append .js (then /index.js) when a relative specifier does not resolve.
// Only for relative paths -- a bare package specifier that fails to resolve is
// a genuinely missing dependency and must keep failing loudly.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw err;
    for (const suffix of [".js", ".mjs", "/index.js"]) {
      try { return await next(specifier + suffix, context); } catch { /* try the next */ }
    }
    throw err;
  }
}
