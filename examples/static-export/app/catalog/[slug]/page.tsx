import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { catalog, getCatalogItem } from "../../../lib/content";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return catalog.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const item = getCatalogItem((await params).slug);
  return item ? { title: item.name, description: item.description } : { title: "Unknown object" };
}

export default async function CatalogItemPage({ params }: Props) {
  const item = getCatalogItem((await params).slug);
  if (!item) notFound();

  return (
    <article className="detail-page">
      <p className="kicker">{item.eyebrow}</p>
      <h1>{item.name}</h1>
      <p className="detail-intro">{item.description}</p>
      <div className="proof-panel">
        <p className="mono">/catalog/{item.slug}/index.html</p>
        <ul>{item.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
      </div>
      <nav className="previous-next" aria-label="Catalog items">
        {catalog.map((entry) => <Link href={`/catalog/${entry.slug}`} key={entry.slug}>{entry.name}</Link>)}
      </nav>
    </article>
  );
}
