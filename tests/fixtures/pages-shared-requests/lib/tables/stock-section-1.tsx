import { formatCell } from "./format-cell";
import styles from "./stock-section-1.module.css";

const ROWS = [
  { id: "stock-1-001", label: "Stock section 1 entry 001", value: 37 },
  { id: "stock-1-002", label: "Stock section 1 entry 002", value: 74 },
  { id: "stock-1-003", label: "Stock section 1 entry 003", value: 111 },
  { id: "stock-1-004", label: "Stock section 1 entry 004", value: 148 },
  { id: "stock-1-005", label: "Stock section 1 entry 005", value: 185 },
  { id: "stock-1-006", label: "Stock section 1 entry 006", value: 222 },
  { id: "stock-1-007", label: "Stock section 1 entry 007", value: 259 },
  { id: "stock-1-008", label: "Stock section 1 entry 008", value: 296 },
  { id: "stock-1-009", label: "Stock section 1 entry 009", value: 333 },
  { id: "stock-1-010", label: "Stock section 1 entry 010", value: 370 },
  { id: "stock-1-011", label: "Stock section 1 entry 011", value: 407 },
  { id: "stock-1-012", label: "Stock section 1 entry 012", value: 444 },
  { id: "stock-1-013", label: "Stock section 1 entry 013", value: 481 },
  { id: "stock-1-014", label: "Stock section 1 entry 014", value: 518 },
  { id: "stock-1-015", label: "Stock section 1 entry 015", value: 555 },
  { id: "stock-1-016", label: "Stock section 1 entry 016", value: 592 },
  { id: "stock-1-017", label: "Stock section 1 entry 017", value: 629 },
  { id: "stock-1-018", label: "Stock section 1 entry 018", value: 666 },
  { id: "stock-1-019", label: "Stock section 1 entry 019", value: 703 },
  { id: "stock-1-020", label: "Stock section 1 entry 020", value: 740 },
  { id: "stock-1-021", label: "Stock section 1 entry 021", value: 777 },
  { id: "stock-1-022", label: "Stock section 1 entry 022", value: 814 },
  { id: "stock-1-023", label: "Stock section 1 entry 023", value: 851 },
  { id: "stock-1-024", label: "Stock section 1 entry 024", value: 888 },
  { id: "stock-1-025", label: "Stock section 1 entry 025", value: 925 },
  { id: "stock-1-026", label: "Stock section 1 entry 026", value: 962 },
  { id: "stock-1-027", label: "Stock section 1 entry 027", value: 999 },
  { id: "stock-1-028", label: "Stock section 1 entry 028", value: 1036 },
  { id: "stock-1-029", label: "Stock section 1 entry 029", value: 1073 },
  { id: "stock-1-030", label: "Stock section 1 entry 030", value: 1110 },
  { id: "stock-1-031", label: "Stock section 1 entry 031", value: 1147 },
  { id: "stock-1-032", label: "Stock section 1 entry 032", value: 1184 },
  { id: "stock-1-033", label: "Stock section 1 entry 033", value: 1221 },
  { id: "stock-1-034", label: "Stock section 1 entry 034", value: 1258 },
  { id: "stock-1-035", label: "Stock section 1 entry 035", value: 1295 },
  { id: "stock-1-036", label: "Stock section 1 entry 036", value: 1332 },
  { id: "stock-1-037", label: "Stock section 1 entry 037", value: 1369 },
  { id: "stock-1-038", label: "Stock section 1 entry 038", value: 1406 },
  { id: "stock-1-039", label: "Stock section 1 entry 039", value: 1443 },
  { id: "stock-1-040", label: "Stock section 1 entry 040", value: 1480 },
  { id: "stock-1-041", label: "Stock section 1 entry 041", value: 1517 },
  { id: "stock-1-042", label: "Stock section 1 entry 042", value: 1554 },
  { id: "stock-1-043", label: "Stock section 1 entry 043", value: 1591 },
  { id: "stock-1-044", label: "Stock section 1 entry 044", value: 1628 },
  { id: "stock-1-045", label: "Stock section 1 entry 045", value: 1665 },
  { id: "stock-1-046", label: "Stock section 1 entry 046", value: 1702 },
  { id: "stock-1-047", label: "Stock section 1 entry 047", value: 1739 },
  { id: "stock-1-048", label: "Stock section 1 entry 048", value: 1776 },
  { id: "stock-1-049", label: "Stock section 1 entry 049", value: 1813 },
  { id: "stock-1-050", label: "Stock section 1 entry 050", value: 1850 },
  { id: "stock-1-051", label: "Stock section 1 entry 051", value: 1887 },
  { id: "stock-1-052", label: "Stock section 1 entry 052", value: 1924 },
  { id: "stock-1-053", label: "Stock section 1 entry 053", value: 1961 },
  { id: "stock-1-054", label: "Stock section 1 entry 054", value: 1998 },
  { id: "stock-1-055", label: "Stock section 1 entry 055", value: 2035 },
  { id: "stock-1-056", label: "Stock section 1 entry 056", value: 2072 },
  { id: "stock-1-057", label: "Stock section 1 entry 057", value: 2109 },
  { id: "stock-1-058", label: "Stock section 1 entry 058", value: 2146 },
  { id: "stock-1-059", label: "Stock section 1 entry 059", value: 2183 },
  { id: "stock-1-060", label: "Stock section 1 entry 060", value: 2220 },
];

// One of 6 sections of the stock list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function StockSection1() {
  return (
    <section className={styles.section} data-marker="marker-stock-section-1">
      <span>{formatCell(ROWS[0]!.label)}</span>
      <p>{ROWS.length}</p>
    </section>
  );
}
