import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { docs, type DocsPath } from "../../../lib/content";

type Props = { params: Promise<{ slug: string[] }> };

export function generateStaticParams() {
  return Object.keys(docs).map((path) => ({ slug: path.split("/") }));
}

function resolveDoc(slug: string[]) {
  return docs[slug.join("/") as DocsPath];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = resolveDoc((await params).slug);
  return page ? { title: page.title, description: page.summary } : { title: "Missing guide" };
}

export default async function DocsPage({ params }: Props) {
  const { slug } = await params;
  const page = resolveDoc(slug);
  if (!page) notFound();

  return (
    <article className="detail-page docs-page">
      <p className="kicker">Catch-all route · {slug.join(" / ")}</p>
      <h1>{page.title}</h1>
      <p className="detail-intro">{page.summary}</p>
      <ol className="steps">
        {page.steps.map((step, index) => <li key={step}><span>0{index + 1}</span><p>{step}</p></li>)}
      </ol>
      <Link className="text-link" href={slug[0] === "building" ? "/docs/deployment/cloudflare" : "/docs/building/the-artifact"}>Read the other guide →</Link>
    </article>
  );
}
