import Script from "next/script";

export default function ScriptDedupePage() {
  return (
    <main>
      <h1>Script Dedupe</h1>
      <Script src="/dedupe-script.js" />
      <Script src="/dedupe-script.js" />
    </main>
  );
}
