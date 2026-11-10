type RecordProps = { searchParams: Promise<{ item?: string | string[] }> };

// Like a schema-validated query, both resolvers reject a missing item.
async function readItem(searchParams: RecordProps["searchParams"]): Promise<string> {
  const { item } = await searchParams;
  if (typeof item !== "string") throw new Error("required-search item is missing");
  return item;
}

export async function generateMetadata({ searchParams }: RecordProps) {
  return { title: `Record ${await readItem(searchParams)}` };
}

export default async function ClientCacheRequiredSearchRecord({ searchParams }: RecordProps) {
  return <p id="required-search-item">{await readItem(searchParams)}</p>;
}
