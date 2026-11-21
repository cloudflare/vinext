// Stands in for a record loaded by param. Only generated params may render it.
export function loadProductRecord(slug: string) {
  return { title: `product-record-${slug}` };
}
