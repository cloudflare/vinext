import { Counter } from "../../counter";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ section: string; id: string }>;
}) {
  const { section, id } = await params;

  return (
    <div>
      <h3>
        Item {id} in section {section}
      </h3>
      <Counter id={`page-${section}-${id}`} label="Page counter" />
    </div>
  );
}

export function generateStaticParams() {
  return [
    { section: "a", id: "1" },
    { section: "a", id: "2" },
    { section: "b", id: "1" },
    { section: "b", id: "2" },
  ];
}
