import React from "react";

interface BlogPostProps {
  slug: string;
  title: string;
}

export default function BlogPost({ slug, title }: BlogPostProps) {
  return (
    <div>
      <h1>{title}</h1>
      <p>Blog post slug: {slug}</p>
    </div>
  );
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { slug: "hello-world" } }, { params: { slug: "getting-started" } }],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  const titles: Record<string, string> = {
    "hello-world": "Hello World",
    "getting-started": "Getting Started with Nextcompat",
  };
  return {
    props: {
      slug: params.slug,
      title: titles[params.slug] ?? "Unknown Post",
    },
  };
}
