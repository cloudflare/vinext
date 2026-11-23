import { formatCell } from "./format-cell";
import styles from "./stock-section-6.module.css";

const ROWS = [
  { id: "stock-6-001", label: "Stock section 6 entry 001", value: 37 },
  { id: "stock-6-002", label: "Stock section 6 entry 002", value: 74 },
  { id: "stock-6-003", label: "Stock section 6 entry 003", value: 111 },
  { id: "stock-6-004", label: "Stock section 6 entry 004", value: 148 },
  { id: "stock-6-005", label: "Stock section 6 entry 005", value: 185 },
  { id: "stock-6-006", label: "Stock section 6 entry 006", value: 222 },
  { id: "stock-6-007", label: "Stock section 6 entry 007", value: 259 },
  { id: "stock-6-008", label: "Stock section 6 entry 008", value: 296 },
  { id: "stock-6-009", label: "Stock section 6 entry 009", value: 333 },
  { id: "stock-6-010", label: "Stock section 6 entry 010", value: 370 },
  { id: "stock-6-011", label: "Stock section 6 entry 011", value: 407 },
  { id: "stock-6-012", label: "Stock section 6 entry 012", value: 444 },
  { id: "stock-6-013", label: "Stock section 6 entry 013", value: 481 },
  { id: "stock-6-014", label: "Stock section 6 entry 014", value: 518 },
  { id: "stock-6-015", label: "Stock section 6 entry 015", value: 555 },
  { id: "stock-6-016", label: "Stock section 6 entry 016", value: 592 },
  { id: "stock-6-017", label: "Stock section 6 entry 017", value: 629 },
  { id: "stock-6-018", label: "Stock section 6 entry 018", value: 666 },
  { id: "stock-6-019", label: "Stock section 6 entry 019", value: 703 },
  { id: "stock-6-020", label: "Stock section 6 entry 020", value: 740 },
  { id: "stock-6-021", label: "Stock section 6 entry 021", value: 777 },
  { id: "stock-6-022", label: "Stock section 6 entry 022", value: 814 },
  { id: "stock-6-023", label: "Stock section 6 entry 023", value: 851 },
  { id: "stock-6-024", label: "Stock section 6 entry 024", value: 888 },
  { id: "stock-6-025", label: "Stock section 6 entry 025", value: 925 },
  { id: "stock-6-026", label: "Stock section 6 entry 026", value: 962 },
  { id: "stock-6-027", label: "Stock section 6 entry 027", value: 999 },
  { id: "stock-6-028", label: "Stock section 6 entry 028", value: 1036 },
  { id: "stock-6-029", label: "Stock section 6 entry 029", value: 1073 },
  { id: "stock-6-030", label: "Stock section 6 entry 030", value: 1110 },
  { id: "stock-6-031", label: "Stock section 6 entry 031", value: 1147 },
  { id: "stock-6-032", label: "Stock section 6 entry 032", value: 1184 },
  { id: "stock-6-033", label: "Stock section 6 entry 033", value: 1221 },
  { id: "stock-6-034", label: "Stock section 6 entry 034", value: 1258 },
  { id: "stock-6-035", label: "Stock section 6 entry 035", value: 1295 },
  { id: "stock-6-036", label: "Stock section 6 entry 036", value: 1332 },
  { id: "stock-6-037", label: "Stock section 6 entry 037", value: 1369 },
  { id: "stock-6-038", label: "Stock section 6 entry 038", value: 1406 },
  { id: "stock-6-039", label: "Stock section 6 entry 039", value: 1443 },
  { id: "stock-6-040", label: "Stock section 6 entry 040", value: 1480 },
  { id: "stock-6-041", label: "Stock section 6 entry 041", value: 1517 },
  { id: "stock-6-042", label: "Stock section 6 entry 042", value: 1554 },
  { id: "stock-6-043", label: "Stock section 6 entry 043", value: 1591 },
  { id: "stock-6-044", label: "Stock section 6 entry 044", value: 1628 },
  { id: "stock-6-045", label: "Stock section 6 entry 045", value: 1665 },
  { id: "stock-6-046", label: "Stock section 6 entry 046", value: 1702 },
  { id: "stock-6-047", label: "Stock section 6 entry 047", value: 1739 },
  { id: "stock-6-048", label: "Stock section 6 entry 048", value: 1776 },
  { id: "stock-6-049", label: "Stock section 6 entry 049", value: 1813 },
  { id: "stock-6-050", label: "Stock section 6 entry 050", value: 1850 },
  { id: "stock-6-051", label: "Stock section 6 entry 051", value: 1887 },
  { id: "stock-6-052", label: "Stock section 6 entry 052", value: 1924 },
  { id: "stock-6-053", label: "Stock section 6 entry 053", value: 1961 },
  { id: "stock-6-054", label: "Stock section 6 entry 054", value: 1998 },
  { id: "stock-6-055", label: "Stock section 6 entry 055", value: 2035 },
  { id: "stock-6-056", label: "Stock section 6 entry 056", value: 2072 },
  { id: "stock-6-057", label: "Stock section 6 entry 057", value: 2109 },
  { id: "stock-6-058", label: "Stock section 6 entry 058", value: 2146 },
  { id: "stock-6-059", label: "Stock section 6 entry 059", value: 2183 },
  { id: "stock-6-060", label: "Stock section 6 entry 060", value: 2220 },
];

// One of 6 sections of the stock list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function StockSection6() {
  return (
    <section className={styles.section} data-marker="marker-stock-section-6">
      <span>{formatCell(ROWS[0]!.label)}</span>
      <p>{ROWS.length}</p>
    </section>
  );
}
