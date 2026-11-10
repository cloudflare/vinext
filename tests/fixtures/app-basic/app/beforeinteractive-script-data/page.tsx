import Script from "next/script";

// Stands in for application data (a stored profile or CMS field) embedded in
// an inline beforeInteractive Script. `JSON.stringify` leaves markup in string
// values untouched, so the hoisted tag must never carry the body as raw HTML:
//   - `<!--<script>` would put the HTML tokenizer in the double-escaped script
//     state, so the rest of the document became text of this script.
//   - `</head>` and `</body></html>` matched the SSR stream's own insertion
//     points inside the hoisted body, splitting the script and turning the
//     data after them into document markup.
const PROFILE = {
  name: "<!--<script>",
  bio: '</head><p id="profile-bio">bio</p></body></html>',
};

function moduleLogScript(name: string): string {
  return `(self.__vinextModuleLog ??= []).push({ name: ${JSON.stringify(name)}, hydrated: typeof self.__VINEXT_HYDRATED_AT === "number" });`;
}

export default function BeforeInteractiveScriptDataPage(): React.ReactElement {
  return (
    <main>
      <Script id="vinext-test-script-data" strategy="beforeInteractive">
        {`self.__vinextScriptData = ${JSON.stringify(PROFILE)};`}
      </Script>
      {/* Inline module scripts without imports run in registration order
          ahead of the parser-deferred bootstrap, so hydration has not
          started yet when they run. */}
      <Script id="vinext-test-module-1" strategy="beforeInteractive" type="module">
        {moduleLogScript("module-1")}
      </Script>
      <Script id="vinext-test-module-2" strategy="beforeInteractive" type="module">
        {moduleLogScript("module-2")}
      </Script>
      <h1 id="script-data-heading">beforeInteractive script data</h1>
    </main>
  );
}
