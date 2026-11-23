import { formatCell } from "./format-cell";
import styles from "./price-section-5.module.css";

const ROWS = [
  { id: "price-5-001", label: "Price section 5 entry 001", value: 37 },
  { id: "price-5-002", label: "Price section 5 entry 002", value: 74 },
  { id: "price-5-003", label: "Price section 5 entry 003", value: 111 },
  { id: "price-5-004", label: "Price section 5 entry 004", value: 148 },
  { id: "price-5-005", label: "Price section 5 entry 005", value: 185 },
  { id: "price-5-006", label: "Price section 5 entry 006", value: 222 },
  { id: "price-5-007", label: "Price section 5 entry 007", value: 259 },
  { id: "price-5-008", label: "Price section 5 entry 008", value: 296 },
  { id: "price-5-009", label: "Price section 5 entry 009", value: 333 },
  { id: "price-5-010", label: "Price section 5 entry 010", value: 370 },
  { id: "price-5-011", label: "Price section 5 entry 011", value: 407 },
  { id: "price-5-012", label: "Price section 5 entry 012", value: 444 },
  { id: "price-5-013", label: "Price section 5 entry 013", value: 481 },
  { id: "price-5-014", label: "Price section 5 entry 014", value: 518 },
  { id: "price-5-015", label: "Price section 5 entry 015", value: 555 },
  { id: "price-5-016", label: "Price section 5 entry 016", value: 592 },
  { id: "price-5-017", label: "Price section 5 entry 017", value: 629 },
  { id: "price-5-018", label: "Price section 5 entry 018", value: 666 },
  { id: "price-5-019", label: "Price section 5 entry 019", value: 703 },
  { id: "price-5-020", label: "Price section 5 entry 020", value: 740 },
  { id: "price-5-021", label: "Price section 5 entry 021", value: 777 },
  { id: "price-5-022", label: "Price section 5 entry 022", value: 814 },
  { id: "price-5-023", label: "Price section 5 entry 023", value: 851 },
  { id: "price-5-024", label: "Price section 5 entry 024", value: 888 },
  { id: "price-5-025", label: "Price section 5 entry 025", value: 925 },
  { id: "price-5-026", label: "Price section 5 entry 026", value: 962 },
  { id: "price-5-027", label: "Price section 5 entry 027", value: 999 },
  { id: "price-5-028", label: "Price section 5 entry 028", value: 1036 },
  { id: "price-5-029", label: "Price section 5 entry 029", value: 1073 },
  { id: "price-5-030", label: "Price section 5 entry 030", value: 1110 },
  { id: "price-5-031", label: "Price section 5 entry 031", value: 1147 },
  { id: "price-5-032", label: "Price section 5 entry 032", value: 1184 },
  { id: "price-5-033", label: "Price section 5 entry 033", value: 1221 },
  { id: "price-5-034", label: "Price section 5 entry 034", value: 1258 },
  { id: "price-5-035", label: "Price section 5 entry 035", value: 1295 },
  { id: "price-5-036", label: "Price section 5 entry 036", value: 1332 },
  { id: "price-5-037", label: "Price section 5 entry 037", value: 1369 },
  { id: "price-5-038", label: "Price section 5 entry 038", value: 1406 },
  { id: "price-5-039", label: "Price section 5 entry 039", value: 1443 },
  { id: "price-5-040", label: "Price section 5 entry 040", value: 1480 },
  { id: "price-5-041", label: "Price section 5 entry 041", value: 1517 },
  { id: "price-5-042", label: "Price section 5 entry 042", value: 1554 },
  { id: "price-5-043", label: "Price section 5 entry 043", value: 1591 },
  { id: "price-5-044", label: "Price section 5 entry 044", value: 1628 },
  { id: "price-5-045", label: "Price section 5 entry 045", value: 1665 },
  { id: "price-5-046", label: "Price section 5 entry 046", value: 1702 },
  { id: "price-5-047", label: "Price section 5 entry 047", value: 1739 },
  { id: "price-5-048", label: "Price section 5 entry 048", value: 1776 },
  { id: "price-5-049", label: "Price section 5 entry 049", value: 1813 },
  { id: "price-5-050", label: "Price section 5 entry 050", value: 1850 },
  { id: "price-5-051", label: "Price section 5 entry 051", value: 1887 },
  { id: "price-5-052", label: "Price section 5 entry 052", value: 1924 },
  { id: "price-5-053", label: "Price section 5 entry 053", value: 1961 },
  { id: "price-5-054", label: "Price section 5 entry 054", value: 1998 },
  { id: "price-5-055", label: "Price section 5 entry 055", value: 2035 },
  { id: "price-5-056", label: "Price section 5 entry 056", value: 2072 },
  { id: "price-5-057", label: "Price section 5 entry 057", value: 2109 },
  { id: "price-5-058", label: "Price section 5 entry 058", value: 2146 },
  { id: "price-5-059", label: "Price section 5 entry 059", value: 2183 },
  { id: "price-5-060", label: "Price section 5 entry 060", value: 2220 },
];

// One of 6 sections of the price list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function PriceSection5() {
  return (
    <section className={styles.section} data-marker="marker-price-section-5">
      <span>{formatCell(ROWS[0]!.label)}</span>
      <p>{ROWS.length}</p>
    </section>
  );
}
