import type { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from "next";
import Head from "next/head";
import Link from "next/link";

const products = {
  atlas: { name: "Atlas Field Kit", detail: "Maps, ruler, compass, and a place for field notes." },
  lantern: { name: "Low-light Lantern", detail: "A warm, dimmable light that preserves night vision." },
} as const;

type ProductId = keyof typeof products;
type Props = { id: ProductId; name: string; detail: string };

export const getStaticPaths = (() => ({
  paths: Object.keys(products).map((id) => ({ params: { id } })),
  fallback: false,
})) satisfies GetStaticPaths;

export const getStaticProps = (async ({ params }) => {
  const id = params?.id as ProductId;
  const product = products[id];
  if (!product) return { notFound: true };
  return { props: { id, ...product } };
}) satisfies GetStaticProps<Props>;

export default function ProductPage({ id, name, detail }: InferGetStaticPropsType<typeof getStaticProps>) {
  return (
    <div className="pages-shell">
      <Head><title>{name} · Static by design</title></Head>
      <p className="kicker">Pages Router · getStaticPaths</p>
      <h1>{name}</h1>
      <p className="detail-intro">{detail}</p>
      <div className="proof-panel">
        <p className="mono">Product ID: {id}</p>
        <p>fallback: false means an unknown product has no runtime escape hatch.</p>
      </div>
      <Link className="button" href="/products/atlas">Atlas</Link>{" "}
      <Link className="button" href="/products/lantern">Lantern</Link>{" "}
      <Link className="button primary" href="/">App Router home</Link>
    </div>
  );
}
