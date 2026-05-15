import React from "react";

interface StringPathProps {
  slug: string;
}

export default function StringPath({ slug }: StringPathProps) {
  return (
    <div>
      <h1>String path</h1>
      <p>Slug: {slug}</p>
    </div>
  );
}

// Next.js allows getStaticPaths to return `paths` as either:
//   - Array<{ params: { ... } }>
//   - Array<string>
// See https://nextjs.org/docs/pages/api-reference/functions/get-static-paths
// and .nextjs-ref/packages/next/src/build/static-paths/pages.ts (handles both
// shapes by running the string path through the route matcher to extract params).
export async function getStaticPaths() {
  return {
    paths: ["/string-paths/hello-world", "/string-paths/another-one"],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: {
      slug: params.slug,
    },
  };
}
