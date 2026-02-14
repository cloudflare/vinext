import db from '#/lib/db';

export async function generateStaticParams() {
  const products = db.product.findMany();

  return products.map((product) => ({ id: product.id }));
}

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
