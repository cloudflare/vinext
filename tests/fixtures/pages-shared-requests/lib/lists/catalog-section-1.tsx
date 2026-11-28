import { Label } from "./label";
import styles from "./catalog-section-1.module.css";

const ROWS = [
  { id: "catalog-1-001", label: "Catalog section 1 entry 001", value: 37 },
  { id: "catalog-1-002", label: "Catalog section 1 entry 002", value: 74 },
  { id: "catalog-1-003", label: "Catalog section 1 entry 003", value: 111 },
  { id: "catalog-1-004", label: "Catalog section 1 entry 004", value: 148 },
  { id: "catalog-1-005", label: "Catalog section 1 entry 005", value: 185 },
  { id: "catalog-1-006", label: "Catalog section 1 entry 006", value: 222 },
  { id: "catalog-1-007", label: "Catalog section 1 entry 007", value: 259 },
  { id: "catalog-1-008", label: "Catalog section 1 entry 008", value: 296 },
  { id: "catalog-1-009", label: "Catalog section 1 entry 009", value: 333 },
  { id: "catalog-1-010", label: "Catalog section 1 entry 010", value: 370 },
  { id: "catalog-1-011", label: "Catalog section 1 entry 011", value: 407 },
  { id: "catalog-1-012", label: "Catalog section 1 entry 012", value: 444 },
  { id: "catalog-1-013", label: "Catalog section 1 entry 013", value: 481 },
  { id: "catalog-1-014", label: "Catalog section 1 entry 014", value: 518 },
  { id: "catalog-1-015", label: "Catalog section 1 entry 015", value: 555 },
  { id: "catalog-1-016", label: "Catalog section 1 entry 016", value: 592 },
  { id: "catalog-1-017", label: "Catalog section 1 entry 017", value: 629 },
  { id: "catalog-1-018", label: "Catalog section 1 entry 018", value: 666 },
  { id: "catalog-1-019", label: "Catalog section 1 entry 019", value: 703 },
  { id: "catalog-1-020", label: "Catalog section 1 entry 020", value: 740 },
  { id: "catalog-1-021", label: "Catalog section 1 entry 021", value: 777 },
  { id: "catalog-1-022", label: "Catalog section 1 entry 022", value: 814 },
  { id: "catalog-1-023", label: "Catalog section 1 entry 023", value: 851 },
  { id: "catalog-1-024", label: "Catalog section 1 entry 024", value: 888 },
  { id: "catalog-1-025", label: "Catalog section 1 entry 025", value: 925 },
  { id: "catalog-1-026", label: "Catalog section 1 entry 026", value: 962 },
  { id: "catalog-1-027", label: "Catalog section 1 entry 027", value: 999 },
  { id: "catalog-1-028", label: "Catalog section 1 entry 028", value: 1036 },
  { id: "catalog-1-029", label: "Catalog section 1 entry 029", value: 1073 },
  { id: "catalog-1-030", label: "Catalog section 1 entry 030", value: 1110 },
  { id: "catalog-1-031", label: "Catalog section 1 entry 031", value: 1147 },
  { id: "catalog-1-032", label: "Catalog section 1 entry 032", value: 1184 },
  { id: "catalog-1-033", label: "Catalog section 1 entry 033", value: 1221 },
  { id: "catalog-1-034", label: "Catalog section 1 entry 034", value: 1258 },
  { id: "catalog-1-035", label: "Catalog section 1 entry 035", value: 1295 },
  { id: "catalog-1-036", label: "Catalog section 1 entry 036", value: 1332 },
  { id: "catalog-1-037", label: "Catalog section 1 entry 037", value: 1369 },
  { id: "catalog-1-038", label: "Catalog section 1 entry 038", value: 1406 },
  { id: "catalog-1-039", label: "Catalog section 1 entry 039", value: 1443 },
  { id: "catalog-1-040", label: "Catalog section 1 entry 040", value: 1480 },
  { id: "catalog-1-041", label: "Catalog section 1 entry 041", value: 1517 },
  { id: "catalog-1-042", label: "Catalog section 1 entry 042", value: 1554 },
  { id: "catalog-1-043", label: "Catalog section 1 entry 043", value: 1591 },
  { id: "catalog-1-044", label: "Catalog section 1 entry 044", value: 1628 },
  { id: "catalog-1-045", label: "Catalog section 1 entry 045", value: 1665 },
  { id: "catalog-1-046", label: "Catalog section 1 entry 046", value: 1702 },
  { id: "catalog-1-047", label: "Catalog section 1 entry 047", value: 1739 },
  { id: "catalog-1-048", label: "Catalog section 1 entry 048", value: 1776 },
  { id: "catalog-1-049", label: "Catalog section 1 entry 049", value: 1813 },
  { id: "catalog-1-050", label: "Catalog section 1 entry 050", value: 1850 },
  { id: "catalog-1-051", label: "Catalog section 1 entry 051", value: 1887 },
  { id: "catalog-1-052", label: "Catalog section 1 entry 052", value: 1924 },
  { id: "catalog-1-053", label: "Catalog section 1 entry 053", value: 1961 },
  { id: "catalog-1-054", label: "Catalog section 1 entry 054", value: 1998 },
  { id: "catalog-1-055", label: "Catalog section 1 entry 055", value: 2035 },
  { id: "catalog-1-056", label: "Catalog section 1 entry 056", value: 2072 },
  { id: "catalog-1-057", label: "Catalog section 1 entry 057", value: 2109 },
  { id: "catalog-1-058", label: "Catalog section 1 entry 058", value: 2146 },
  { id: "catalog-1-059", label: "Catalog section 1 entry 059", value: 2183 },
  { id: "catalog-1-060", label: "Catalog section 1 entry 060", value: 2220 },
];

// One of 6 sections of the catalog list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function CatalogSection1() {
  return (
    <section className={styles.section} data-marker="marker-catalog-section-1">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
