import { CatalogSection1 } from "./catalog-section-1";
import { CatalogSection2 } from "./catalog-section-2";
import { CatalogSection3 } from "./catalog-section-3";
import { CatalogSection4 } from "./catalog-section-4";
import { CatalogSection5 } from "./catalog-section-5";
import { CatalogSection6 } from "./catalog-section-6";

// The catalog list: 6 sections that are over 20 kB together.
export function CatalogList() {
  return (
    <div data-marker="marker-catalog-list">
      <CatalogSection1 />
      <CatalogSection2 />
      <CatalogSection3 />
      <CatalogSection4 />
      <CatalogSection5 />
      <CatalogSection6 />
    </div>
  );
}
