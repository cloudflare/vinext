import { CATALOG_ROWS_1 } from "./catalog-rows-1";
import { CATALOG_ROWS_2 } from "./catalog-rows-2";
import { CATALOG_ROWS_3 } from "./catalog-rows-3";
import { Dot } from "./dot";
import { Label } from "./label";

const ROWS = [...CATALOG_ROWS_1, ...CATALOG_ROWS_2, ...CATALOG_ROWS_3];

// The catalog list and its rows: over 20 kB together, in files that are each
// under it. `/catalog` and `/overview` render it.
export function CatalogList() {
  return (
    <section data-marker="marker-catalog-list">
      <Dot />
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
