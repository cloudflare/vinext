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
