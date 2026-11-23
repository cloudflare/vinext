import { Label } from "./label";
import styles from "./order-section-1.module.css";

const ROWS = [
  { id: "order-1-001", label: "Order section 1 entry 001", value: 37 },
  { id: "order-1-002", label: "Order section 1 entry 002", value: 74 },
  { id: "order-1-003", label: "Order section 1 entry 003", value: 111 },
  { id: "order-1-004", label: "Order section 1 entry 004", value: 148 },
  { id: "order-1-005", label: "Order section 1 entry 005", value: 185 },
  { id: "order-1-006", label: "Order section 1 entry 006", value: 222 },
  { id: "order-1-007", label: "Order section 1 entry 007", value: 259 },
  { id: "order-1-008", label: "Order section 1 entry 008", value: 296 },
  { id: "order-1-009", label: "Order section 1 entry 009", value: 333 },
  { id: "order-1-010", label: "Order section 1 entry 010", value: 370 },
  { id: "order-1-011", label: "Order section 1 entry 011", value: 407 },
  { id: "order-1-012", label: "Order section 1 entry 012", value: 444 },
  { id: "order-1-013", label: "Order section 1 entry 013", value: 481 },
  { id: "order-1-014", label: "Order section 1 entry 014", value: 518 },
  { id: "order-1-015", label: "Order section 1 entry 015", value: 555 },
  { id: "order-1-016", label: "Order section 1 entry 016", value: 592 },
  { id: "order-1-017", label: "Order section 1 entry 017", value: 629 },
  { id: "order-1-018", label: "Order section 1 entry 018", value: 666 },
  { id: "order-1-019", label: "Order section 1 entry 019", value: 703 },
  { id: "order-1-020", label: "Order section 1 entry 020", value: 740 },
  { id: "order-1-021", label: "Order section 1 entry 021", value: 777 },
  { id: "order-1-022", label: "Order section 1 entry 022", value: 814 },
  { id: "order-1-023", label: "Order section 1 entry 023", value: 851 },
  { id: "order-1-024", label: "Order section 1 entry 024", value: 888 },
  { id: "order-1-025", label: "Order section 1 entry 025", value: 925 },
  { id: "order-1-026", label: "Order section 1 entry 026", value: 962 },
  { id: "order-1-027", label: "Order section 1 entry 027", value: 999 },
  { id: "order-1-028", label: "Order section 1 entry 028", value: 1036 },
  { id: "order-1-029", label: "Order section 1 entry 029", value: 1073 },
  { id: "order-1-030", label: "Order section 1 entry 030", value: 1110 },
  { id: "order-1-031", label: "Order section 1 entry 031", value: 1147 },
  { id: "order-1-032", label: "Order section 1 entry 032", value: 1184 },
  { id: "order-1-033", label: "Order section 1 entry 033", value: 1221 },
  { id: "order-1-034", label: "Order section 1 entry 034", value: 1258 },
  { id: "order-1-035", label: "Order section 1 entry 035", value: 1295 },
  { id: "order-1-036", label: "Order section 1 entry 036", value: 1332 },
  { id: "order-1-037", label: "Order section 1 entry 037", value: 1369 },
  { id: "order-1-038", label: "Order section 1 entry 038", value: 1406 },
  { id: "order-1-039", label: "Order section 1 entry 039", value: 1443 },
  { id: "order-1-040", label: "Order section 1 entry 040", value: 1480 },
  { id: "order-1-041", label: "Order section 1 entry 041", value: 1517 },
  { id: "order-1-042", label: "Order section 1 entry 042", value: 1554 },
  { id: "order-1-043", label: "Order section 1 entry 043", value: 1591 },
  { id: "order-1-044", label: "Order section 1 entry 044", value: 1628 },
  { id: "order-1-045", label: "Order section 1 entry 045", value: 1665 },
  { id: "order-1-046", label: "Order section 1 entry 046", value: 1702 },
  { id: "order-1-047", label: "Order section 1 entry 047", value: 1739 },
  { id: "order-1-048", label: "Order section 1 entry 048", value: 1776 },
  { id: "order-1-049", label: "Order section 1 entry 049", value: 1813 },
  { id: "order-1-050", label: "Order section 1 entry 050", value: 1850 },
  { id: "order-1-051", label: "Order section 1 entry 051", value: 1887 },
  { id: "order-1-052", label: "Order section 1 entry 052", value: 1924 },
  { id: "order-1-053", label: "Order section 1 entry 053", value: 1961 },
  { id: "order-1-054", label: "Order section 1 entry 054", value: 1998 },
  { id: "order-1-055", label: "Order section 1 entry 055", value: 2035 },
  { id: "order-1-056", label: "Order section 1 entry 056", value: 2072 },
  { id: "order-1-057", label: "Order section 1 entry 057", value: 2109 },
  { id: "order-1-058", label: "Order section 1 entry 058", value: 2146 },
  { id: "order-1-059", label: "Order section 1 entry 059", value: 2183 },
  { id: "order-1-060", label: "Order section 1 entry 060", value: 2220 },
];

// One of 6 sections of the order list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function OrderSection1() {
  return (
    <section className={styles.section} data-marker="marker-order-section-1">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
