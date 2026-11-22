// Ported from Next.js: packages/next-routing/src/__tests__/dynamic-after-rewrites.test.ts
// https://github.com/vercel/next.js/blob/2196d36/packages/next-routing/src/__tests__/dynamic-after-rewrites.test.ts
export const rewriteDestinationCases = ["after", "fallback"].flatMap((phase) =>
  ["app", "pages"].flatMap((router) => {
    const source = `/rewrite-destination-${phase}/${router}`;
    return [
      { source: `${source}/fixed`, marker: `${router} static</p>` },
      { source: `${source}/roaming`, marker: `${router} dynamic: roaming</p>` },
    ];
  }),
);
