import Script from "next/script";

export default function ScriptNavigationTarget() {
  return (
    <main>
      <h1>Script Navigation Target</h1>
      <Script
        id="pages-navigation-before"
        src="/pages-navigation-before.js"
        strategy="beforeInteractive"
      />
    </main>
  );
}
