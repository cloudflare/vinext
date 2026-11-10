type Props = { searchParams: Promise<{ item?: string }> };

export async function generateMetadata({ searchParams }: Props) {
  return { title: `Record ${await readItem(searchParams)}` };
}

export default async function Page({ searchParams }: Props) {
  return <QueryResult searchParams={searchParams} />;
}

async function QueryResult({ searchParams }: Props) {
  return <p id="required-query-item">{await readItem(searchParams)}</p>;
}

async function readItem(searchParams: Props["searchParams"]) {
  const { item } = await searchParams;
  if (typeof item !== "string") throw new Error("Required query parameter item is missing");
  return item;
}
