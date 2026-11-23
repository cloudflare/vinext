import { Label } from "./label";
import styles from "./catalog-section-6.module.css";

const ROWS = [
  { id: "catalog-6-001", label: "Catalog section 6 entry 001", value: 37 },
  { id: "catalog-6-002", label: "Catalog section 6 entry 002", value: 74 },
  { id: "catalog-6-003", label: "Catalog section 6 entry 003", value: 111 },
  { id: "catalog-6-004", label: "Catalog section 6 entry 004", value: 148 },
  { id: "catalog-6-005", label: "Catalog section 6 entry 005", value: 185 },
  { id: "catalog-6-006", label: "Catalog section 6 entry 006", value: 222 },
  { id: "catalog-6-007", label: "Catalog section 6 entry 007", value: 259 },
  { id: "catalog-6-008", label: "Catalog section 6 entry 008", value: 296 },
  { id: "catalog-6-009", label: "Catalog section 6 entry 009", value: 333 },
  { id: "catalog-6-010", label: "Catalog section 6 entry 010", value: 370 },
  { id: "catalog-6-011", label: "Catalog section 6 entry 011", value: 407 },
  { id: "catalog-6-012", label: "Catalog section 6 entry 012", value: 444 },
  { id: "catalog-6-013", label: "Catalog section 6 entry 013", value: 481 },
  { id: "catalog-6-014", label: "Catalog section 6 entry 014", value: 518 },
  { id: "catalog-6-015", label: "Catalog section 6 entry 015", value: 555 },
  { id: "catalog-6-016", label: "Catalog section 6 entry 016", value: 592 },
  { id: "catalog-6-017", label: "Catalog section 6 entry 017", value: 629 },
  { id: "catalog-6-018", label: "Catalog section 6 entry 018", value: 666 },
  { id: "catalog-6-019", label: "Catalog section 6 entry 019", value: 703 },
  { id: "catalog-6-020", label: "Catalog section 6 entry 020", value: 740 },
  { id: "catalog-6-021", label: "Catalog section 6 entry 021", value: 777 },
  { id: "catalog-6-022", label: "Catalog section 6 entry 022", value: 814 },
  { id: "catalog-6-023", label: "Catalog section 6 entry 023", value: 851 },
  { id: "catalog-6-024", label: "Catalog section 6 entry 024", value: 888 },
  { id: "catalog-6-025", label: "Catalog section 6 entry 025", value: 925 },
  { id: "catalog-6-026", label: "Catalog section 6 entry 026", value: 962 },
  { id: "catalog-6-027", label: "Catalog section 6 entry 027", value: 999 },
  { id: "catalog-6-028", label: "Catalog section 6 entry 028", value: 1036 },
  { id: "catalog-6-029", label: "Catalog section 6 entry 029", value: 1073 },
  { id: "catalog-6-030", label: "Catalog section 6 entry 030", value: 1110 },
  { id: "catalog-6-031", label: "Catalog section 6 entry 031", value: 1147 },
  { id: "catalog-6-032", label: "Catalog section 6 entry 032", value: 1184 },
  { id: "catalog-6-033", label: "Catalog section 6 entry 033", value: 1221 },
  { id: "catalog-6-034", label: "Catalog section 6 entry 034", value: 1258 },
  { id: "catalog-6-035", label: "Catalog section 6 entry 035", value: 1295 },
  { id: "catalog-6-036", label: "Catalog section 6 entry 036", value: 1332 },
  { id: "catalog-6-037", label: "Catalog section 6 entry 037", value: 1369 },
  { id: "catalog-6-038", label: "Catalog section 6 entry 038", value: 1406 },
  { id: "catalog-6-039", label: "Catalog section 6 entry 039", value: 1443 },
  { id: "catalog-6-040", label: "Catalog section 6 entry 040", value: 1480 },
  { id: "catalog-6-041", label: "Catalog section 6 entry 041", value: 1517 },
  { id: "catalog-6-042", label: "Catalog section 6 entry 042", value: 1554 },
  { id: "catalog-6-043", label: "Catalog section 6 entry 043", value: 1591 },
  { id: "catalog-6-044", label: "Catalog section 6 entry 044", value: 1628 },
  { id: "catalog-6-045", label: "Catalog section 6 entry 045", value: 1665 },
  { id: "catalog-6-046", label: "Catalog section 6 entry 046", value: 1702 },
  { id: "catalog-6-047", label: "Catalog section 6 entry 047", value: 1739 },
  { id: "catalog-6-048", label: "Catalog section 6 entry 048", value: 1776 },
  { id: "catalog-6-049", label: "Catalog section 6 entry 049", value: 1813 },
  { id: "catalog-6-050", label: "Catalog section 6 entry 050", value: 1850 },
  { id: "catalog-6-051", label: "Catalog section 6 entry 051", value: 1887 },
  { id: "catalog-6-052", label: "Catalog section 6 entry 052", value: 1924 },
  { id: "catalog-6-053", label: "Catalog section 6 entry 053", value: 1961 },
  { id: "catalog-6-054", label: "Catalog section 6 entry 054", value: 1998 },
  { id: "catalog-6-055", label: "Catalog section 6 entry 055", value: 2035 },
  { id: "catalog-6-056", label: "Catalog section 6 entry 056", value: 2072 },
  { id: "catalog-6-057", label: "Catalog section 6 entry 057", value: 2109 },
  { id: "catalog-6-058", label: "Catalog section 6 entry 058", value: 2146 },
  { id: "catalog-6-059", label: "Catalog section 6 entry 059", value: 2183 },
  { id: "catalog-6-060", label: "Catalog section 6 entry 060", value: 2220 },
];

// One of 6 sections of the catalog list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function CatalogSection6() {
  return (
    <section className={styles.section} data-marker="marker-catalog-section-6">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
