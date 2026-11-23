import { formatCell } from "./format-cell";
import styles from "./price-section-6.module.css";

const ROWS = [
  { id: "price-6-001", label: "Price section 6 entry 001", value: 37 },
  { id: "price-6-002", label: "Price section 6 entry 002", value: 74 },
  { id: "price-6-003", label: "Price section 6 entry 003", value: 111 },
  { id: "price-6-004", label: "Price section 6 entry 004", value: 148 },
  { id: "price-6-005", label: "Price section 6 entry 005", value: 185 },
  { id: "price-6-006", label: "Price section 6 entry 006", value: 222 },
  { id: "price-6-007", label: "Price section 6 entry 007", value: 259 },
  { id: "price-6-008", label: "Price section 6 entry 008", value: 296 },
  { id: "price-6-009", label: "Price section 6 entry 009", value: 333 },
  { id: "price-6-010", label: "Price section 6 entry 010", value: 370 },
  { id: "price-6-011", label: "Price section 6 entry 011", value: 407 },
  { id: "price-6-012", label: "Price section 6 entry 012", value: 444 },
  { id: "price-6-013", label: "Price section 6 entry 013", value: 481 },
  { id: "price-6-014", label: "Price section 6 entry 014", value: 518 },
  { id: "price-6-015", label: "Price section 6 entry 015", value: 555 },
  { id: "price-6-016", label: "Price section 6 entry 016", value: 592 },
  { id: "price-6-017", label: "Price section 6 entry 017", value: 629 },
  { id: "price-6-018", label: "Price section 6 entry 018", value: 666 },
  { id: "price-6-019", label: "Price section 6 entry 019", value: 703 },
  { id: "price-6-020", label: "Price section 6 entry 020", value: 740 },
  { id: "price-6-021", label: "Price section 6 entry 021", value: 777 },
  { id: "price-6-022", label: "Price section 6 entry 022", value: 814 },
  { id: "price-6-023", label: "Price section 6 entry 023", value: 851 },
  { id: "price-6-024", label: "Price section 6 entry 024", value: 888 },
  { id: "price-6-025", label: "Price section 6 entry 025", value: 925 },
  { id: "price-6-026", label: "Price section 6 entry 026", value: 962 },
  { id: "price-6-027", label: "Price section 6 entry 027", value: 999 },
  { id: "price-6-028", label: "Price section 6 entry 028", value: 1036 },
  { id: "price-6-029", label: "Price section 6 entry 029", value: 1073 },
  { id: "price-6-030", label: "Price section 6 entry 030", value: 1110 },
  { id: "price-6-031", label: "Price section 6 entry 031", value: 1147 },
  { id: "price-6-032", label: "Price section 6 entry 032", value: 1184 },
  { id: "price-6-033", label: "Price section 6 entry 033", value: 1221 },
  { id: "price-6-034", label: "Price section 6 entry 034", value: 1258 },
  { id: "price-6-035", label: "Price section 6 entry 035", value: 1295 },
  { id: "price-6-036", label: "Price section 6 entry 036", value: 1332 },
  { id: "price-6-037", label: "Price section 6 entry 037", value: 1369 },
  { id: "price-6-038", label: "Price section 6 entry 038", value: 1406 },
  { id: "price-6-039", label: "Price section 6 entry 039", value: 1443 },
  { id: "price-6-040", label: "Price section 6 entry 040", value: 1480 },
  { id: "price-6-041", label: "Price section 6 entry 041", value: 1517 },
  { id: "price-6-042", label: "Price section 6 entry 042", value: 1554 },
  { id: "price-6-043", label: "Price section 6 entry 043", value: 1591 },
  { id: "price-6-044", label: "Price section 6 entry 044", value: 1628 },
  { id: "price-6-045", label: "Price section 6 entry 045", value: 1665 },
  { id: "price-6-046", label: "Price section 6 entry 046", value: 1702 },
  { id: "price-6-047", label: "Price section 6 entry 047", value: 1739 },
  { id: "price-6-048", label: "Price section 6 entry 048", value: 1776 },
  { id: "price-6-049", label: "Price section 6 entry 049", value: 1813 },
  { id: "price-6-050", label: "Price section 6 entry 050", value: 1850 },
  { id: "price-6-051", label: "Price section 6 entry 051", value: 1887 },
  { id: "price-6-052", label: "Price section 6 entry 052", value: 1924 },
  { id: "price-6-053", label: "Price section 6 entry 053", value: 1961 },
  { id: "price-6-054", label: "Price section 6 entry 054", value: 1998 },
  { id: "price-6-055", label: "Price section 6 entry 055", value: 2035 },
  { id: "price-6-056", label: "Price section 6 entry 056", value: 2072 },
  { id: "price-6-057", label: "Price section 6 entry 057", value: 2109 },
  { id: "price-6-058", label: "Price section 6 entry 058", value: 2146 },
  { id: "price-6-059", label: "Price section 6 entry 059", value: 2183 },
  { id: "price-6-060", label: "Price section 6 entry 060", value: 2220 },
];

// One of 6 sections of the price list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function PriceSection6() {
  return (
    <section className={styles.section} data-marker="marker-price-section-6">
      <span>{formatCell(ROWS[0]!.label)}</span>
      <p>{ROWS.length}</p>
    </section>
  );
}
