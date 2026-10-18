import { useState } from "react";
import Head from "next/head";

// Simulates a CMS SEO helper that spreads stored attribute objects onto
// <Head> children. HTML attribute names are case-insensitive, so every case
// variant of an `on*` name must be dropped, as React's server renderer does.
const ssrLinkAttrs: Record<string, string> = {
  ONERROR: "window.__headEventHandlerRan = 'ssr-link'",
  Onload: "window.__headEventHandlerRan = 'ssr-link'",
};

const clientScriptAttrs: Record<string, string> = {
  ONERROR: "window.__headEventHandlerRan = 'client-script'",
  oNlOaD: "window.__headEventHandlerRan = 'client-script'",
};

export default function HeadEventHandlerAttrs() {
  const [showClientTags, setShowClientTags] = useState(false);

  return (
    <>
      <Head>
        <link rel="stylesheet" href="/head-event-handler-missing.css" {...ssrLinkAttrs} />
        <meta name="head-event-handler" content="ssr" {...ssrLinkAttrs} />
      </Head>
      {showClientTags && (
        <Head>
          <script src="/head-event-handler-missing.js" {...clientScriptAttrs} />
        </Head>
      )}
      <h1>Head event handler attributes</h1>
      <button type="button" onClick={() => setShowClientTags(true)}>
        Add client head tags
      </button>
    </>
  );
}
