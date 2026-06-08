export default function RequireContextWithRegex() {
  const translationsContext = (require as any).context("./grandparent", true, /\.js/);

  // Same context but with a global-flagged regexp. A naive `new RegExp(src, "g")`
  // filter is stateful via `lastIndex` and would silently drop every other
  // matching module, so this locks in that `g`/`y` flags are stripped.
  const globalFlagContext = (require as any).context("./grandparent", true, /\.js/g);

  return (
    <>
      <pre id="require-context-keys">{JSON.stringify(translationsContext.keys())}</pre>
      <pre id="require-context-keys-global">{JSON.stringify(globalFlagContext.keys())}</pre>
    </>
  );
}
