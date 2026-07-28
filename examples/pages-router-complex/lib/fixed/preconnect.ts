/**
 * Origins the document warms up. Rendered verbatim as <link> elements in
 * _document's <Head>.
 */
export const preconnectTargets: Array<{
  rel: string;
  href: string;
  crossOrigin?: "anonymous";
}> = [
  { rel: "preconnect", href: "https://cdn.atlas-fixture.test", crossOrigin: "anonymous" },
  { rel: "dns-prefetch", href: "https://cdn.atlas-fixture.test" },
  { rel: "preconnect", href: "https://media.atlas-fixture.test" },
];
