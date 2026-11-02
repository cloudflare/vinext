import Script from "next/script";

// Stands in for application data (a stored profile or CMS field) embedded in
// an inline beforeInteractive Script. `JSON.stringify` leaves `<!--<script>`
// untouched, so the hoisted tag must escape the `<script` opener the way React
// does; otherwise the HTML tokenizer enters the double-escaped script state and
// the rest of the document becomes text of this script.
const PROFILE = { name: "<!--<script>" };

export default function BeforeInteractiveScriptDataPage(): React.ReactElement {
  return (
    <main>
      <Script id="vinext-test-script-data" strategy="beforeInteractive">
        {`self.__vinextScriptData = ${JSON.stringify(PROFILE)};`}
      </Script>
      <h1 id="script-data-heading">beforeInteractive script data</h1>
    </main>
  );
}
