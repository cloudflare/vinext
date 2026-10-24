import { loadProductRecord } from "./record";

type Props = { children: React.ReactNode; params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Omit<Props, "children">) {
  const { slug } = await params;
  return { title: loadProductRecord(slug).title };
}

export default async function Layout({ children, params }: Props) {
  const { slug } = await params;
  return (
    <div id="product-layout">
      <p id="product-record">{loadProductRecord(slug).title}</p>
      {children}
    </div>
  );
}
