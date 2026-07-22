import React from "react";

export default function MissingParams() {
  return <div>missing-params</div>;
}

// Returns an item with no `params` key. Next.js throws
//   "A required parameter (slug) was not provided as a string received undefined"
// (see .nextjs-ref/packages/next/src/build/static-paths/pages.ts around line 169).
// vinext mirrors this by surfacing a per-route error in the prerender result
// rather than crashing the whole prerender phase.
export async function getStaticPaths() {
  return {
    paths: [
      { params: { slug: "ok" } } as { params: { slug: string } } | { locale: string },
      // Force the wrong shape past the type checker — we are testing the
      // runtime defensive behavior, not the type system.
      { locale: "en" } as unknown as { params: { slug: string } },
    ],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}
