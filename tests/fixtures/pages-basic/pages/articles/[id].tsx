import React from "react";

interface ArticleProps {
  id: string;
  title: string;
}

export default function Article({ id, title }: ArticleProps) {
  return (
    <div>
      <h1>{title}</h1>
      <p>Article ID: {id}</p>
    </div>
  );
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { id: "1" } }, { params: { id: "2" } }],
    fallback: "blocking",
  };
}

export async function getStaticProps({ params }: { params: { id: string } }) {
  const titles: Record<string, string> = {
    "1": "First Article",
    "2": "Second Article",
  };
  return {
    props: {
      id: params.id,
      title: titles[params.id] ?? `Article ${params.id}`,
    },
  };
}
