import React from "react";
import { useRouter } from "next/router";

interface ProductProps {
  pid: string;
  name: string;
}

export default function Product({ pid, name }: ProductProps) {
  const router = useRouter();

  // When fallback: true and the page hasn't been generated yet,
  // router.isFallback would be true and props would be empty.
  if (router.isFallback) {
    return <div>Loading product...</div>;
  }

  return (
    <div>
      <h1>Product: {name}</h1>
      <p>Product ID: {pid}</p>
      <p data-testid="is-fallback">isFallback: {String(router.isFallback)}</p>
    </div>
  );
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { pid: "widget" } }, { params: { pid: "gadget" } }],
    fallback: true,
  };
}

export async function getStaticProps({ params }: { params: { pid: string } }) {
  const products: Record<string, string> = {
    widget: "Super Widget",
    gadget: "Mega Gadget",
  };
  return {
    props: {
      pid: params.pid,
      name: products[params.pid] ?? `Product ${params.pid}`,
    },
  };
}
