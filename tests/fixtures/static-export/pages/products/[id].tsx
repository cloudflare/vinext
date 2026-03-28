interface ProductProps {
  id: string;
  name: string;
}

export default function Product({ id, name }: ProductProps) {
  return (
    <main>
      <h1>{name}</h1>
      <p>Product ID: {id}</p>
    </main>
  );
}

export async function getStaticPaths() {
  return {
    paths: [
      { params: { id: "widget" } },
      { params: { id: "gadget" } },
      { params: { id: "doohickey" } },
    ],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { id: string } }) {
  const names: Record<string, string> = {
    widget: "The Widget",
    gadget: "The Gadget",
    doohickey: "The Doohickey",
  };
  return {
    props: {
      id: params.id,
      name: names[params.id] ?? `Product ${params.id}`,
    },
  };
}
