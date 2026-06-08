export default function RequireContextWithRegex() {
  const translationsContext = (require as any).context("./grandparent", true, /\.js/);

  // Same context but with a global-flagged regexp. A naive `new RegExp(src, "g")`
  // filter is stateful via `lastIndex` and would silently drop every other
  // matching module, so this locks in that `g`/`y` flags are stripped.
  const globalFlagContext = (require as any).context("./grandparent", true, /\.js/g);

  // Resolve a module through the context callable (the most common real-world
  // usage: `ctx(ctx.keys()[i]).default`).
  const file1 = translationsContext("./parent/file1.js").default;

  // Unknown keys must throw with a webpack-compatible `MODULE_NOT_FOUND` code.
  let missingCode = "no-throw";
  try {
    translationsContext("./does-not-exist.js");
  } catch (error) {
    missingCode = (error as { code?: string }).code ?? "no-code";
  }

  return (
    <>
      <pre id="require-context-keys">{JSON.stringify(translationsContext.keys())}</pre>
      <pre id="require-context-keys-global">{JSON.stringify(globalFlagContext.keys())}</pre>
      <pre id="require-context-file1">{file1}</pre>
      <pre id="require-context-missing-code">{missingCode}</pre>
    </>
  );
}
