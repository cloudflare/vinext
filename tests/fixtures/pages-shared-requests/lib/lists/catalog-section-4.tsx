import { Label } from "./label";
import styles from "./catalog-section-4.module.css";

const ROWS = [
  { id: "catalog-4-001", label: "Catalog section 4 entry 001", value: 37 },
  { id: "catalog-4-002", label: "Catalog section 4 entry 002", value: 74 },
  { id: "catalog-4-003", label: "Catalog section 4 entry 003", value: 111 },
  { id: "catalog-4-004", label: "Catalog section 4 entry 004", value: 148 },
  { id: "catalog-4-005", label: "Catalog section 4 entry 005", value: 185 },
  { id: "catalog-4-006", label: "Catalog section 4 entry 006", value: 222 },
  { id: "catalog-4-007", label: "Catalog section 4 entry 007", value: 259 },
  { id: "catalog-4-008", label: "Catalog section 4 entry 008", value: 296 },
  { id: "catalog-4-009", label: "Catalog section 4 entry 009", value: 333 },
  { id: "catalog-4-010", label: "Catalog section 4 entry 010", value: 370 },
  { id: "catalog-4-011", label: "Catalog section 4 entry 011", value: 407 },
  { id: "catalog-4-012", label: "Catalog section 4 entry 012", value: 444 },
  { id: "catalog-4-013", label: "Catalog section 4 entry 013", value: 481 },
  { id: "catalog-4-014", label: "Catalog section 4 entry 014", value: 518 },
  { id: "catalog-4-015", label: "Catalog section 4 entry 015", value: 555 },
  { id: "catalog-4-016", label: "Catalog section 4 entry 016", value: 592 },
  { id: "catalog-4-017", label: "Catalog section 4 entry 017", value: 629 },
  { id: "catalog-4-018", label: "Catalog section 4 entry 018", value: 666 },
  { id: "catalog-4-019", label: "Catalog section 4 entry 019", value: 703 },
  { id: "catalog-4-020", label: "Catalog section 4 entry 020", value: 740 },
  { id: "catalog-4-021", label: "Catalog section 4 entry 021", value: 777 },
  { id: "catalog-4-022", label: "Catalog section 4 entry 022", value: 814 },
  { id: "catalog-4-023", label: "Catalog section 4 entry 023", value: 851 },
  { id: "catalog-4-024", label: "Catalog section 4 entry 024", value: 888 },
  { id: "catalog-4-025", label: "Catalog section 4 entry 025", value: 925 },
  { id: "catalog-4-026", label: "Catalog section 4 entry 026", value: 962 },
  { id: "catalog-4-027", label: "Catalog section 4 entry 027", value: 999 },
  { id: "catalog-4-028", label: "Catalog section 4 entry 028", value: 1036 },
  { id: "catalog-4-029", label: "Catalog section 4 entry 029", value: 1073 },
  { id: "catalog-4-030", label: "Catalog section 4 entry 030", value: 1110 },
  { id: "catalog-4-031", label: "Catalog section 4 entry 031", value: 1147 },
  { id: "catalog-4-032", label: "Catalog section 4 entry 032", value: 1184 },
  { id: "catalog-4-033", label: "Catalog section 4 entry 033", value: 1221 },
  { id: "catalog-4-034", label: "Catalog section 4 entry 034", value: 1258 },
  { id: "catalog-4-035", label: "Catalog section 4 entry 035", value: 1295 },
  { id: "catalog-4-036", label: "Catalog section 4 entry 036", value: 1332 },
  { id: "catalog-4-037", label: "Catalog section 4 entry 037", value: 1369 },
  { id: "catalog-4-038", label: "Catalog section 4 entry 038", value: 1406 },
  { id: "catalog-4-039", label: "Catalog section 4 entry 039", value: 1443 },
  { id: "catalog-4-040", label: "Catalog section 4 entry 040", value: 1480 },
  { id: "catalog-4-041", label: "Catalog section 4 entry 041", value: 1517 },
  { id: "catalog-4-042", label: "Catalog section 4 entry 042", value: 1554 },
  { id: "catalog-4-043", label: "Catalog section 4 entry 043", value: 1591 },
  { id: "catalog-4-044", label: "Catalog section 4 entry 044", value: 1628 },
  { id: "catalog-4-045", label: "Catalog section 4 entry 045", value: 1665 },
  { id: "catalog-4-046", label: "Catalog section 4 entry 046", value: 1702 },
  { id: "catalog-4-047", label: "Catalog section 4 entry 047", value: 1739 },
  { id: "catalog-4-048", label: "Catalog section 4 entry 048", value: 1776 },
  { id: "catalog-4-049", label: "Catalog section 4 entry 049", value: 1813 },
  { id: "catalog-4-050", label: "Catalog section 4 entry 050", value: 1850 },
  { id: "catalog-4-051", label: "Catalog section 4 entry 051", value: 1887 },
  { id: "catalog-4-052", label: "Catalog section 4 entry 052", value: 1924 },
  { id: "catalog-4-053", label: "Catalog section 4 entry 053", value: 1961 },
  { id: "catalog-4-054", label: "Catalog section 4 entry 054", value: 1998 },
  { id: "catalog-4-055", label: "Catalog section 4 entry 055", value: 2035 },
  { id: "catalog-4-056", label: "Catalog section 4 entry 056", value: 2072 },
  { id: "catalog-4-057", label: "Catalog section 4 entry 057", value: 2109 },
  { id: "catalog-4-058", label: "Catalog section 4 entry 058", value: 2146 },
  { id: "catalog-4-059", label: "Catalog section 4 entry 059", value: 2183 },
  { id: "catalog-4-060", label: "Catalog section 4 entry 060", value: 2220 },
];

// One of 6 sections of the catalog list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function CatalogSection4() {
  return (
    <section className={styles.section} data-marker="marker-catalog-section-4">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
