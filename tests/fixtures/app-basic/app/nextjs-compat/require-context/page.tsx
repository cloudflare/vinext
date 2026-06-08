export default function RequireContextWithRegex() {
  const translationsContext = (require as any).context(
    "./grandparent",
    true,
    /\.js/,
  );

  return <pre id="require-context-keys">{JSON.stringify(translationsContext.keys())}</pre>;
}
