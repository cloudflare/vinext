import { Label } from "./label";
import styles from "./order-section-2.module.css";

const ROWS = [
  { id: "order-2-001", label: "Order section 2 entry 001", value: 37 },
  { id: "order-2-002", label: "Order section 2 entry 002", value: 74 },
  { id: "order-2-003", label: "Order section 2 entry 003", value: 111 },
  { id: "order-2-004", label: "Order section 2 entry 004", value: 148 },
  { id: "order-2-005", label: "Order section 2 entry 005", value: 185 },
  { id: "order-2-006", label: "Order section 2 entry 006", value: 222 },
  { id: "order-2-007", label: "Order section 2 entry 007", value: 259 },
  { id: "order-2-008", label: "Order section 2 entry 008", value: 296 },
  { id: "order-2-009", label: "Order section 2 entry 009", value: 333 },
  { id: "order-2-010", label: "Order section 2 entry 010", value: 370 },
  { id: "order-2-011", label: "Order section 2 entry 011", value: 407 },
  { id: "order-2-012", label: "Order section 2 entry 012", value: 444 },
  { id: "order-2-013", label: "Order section 2 entry 013", value: 481 },
  { id: "order-2-014", label: "Order section 2 entry 014", value: 518 },
  { id: "order-2-015", label: "Order section 2 entry 015", value: 555 },
  { id: "order-2-016", label: "Order section 2 entry 016", value: 592 },
  { id: "order-2-017", label: "Order section 2 entry 017", value: 629 },
  { id: "order-2-018", label: "Order section 2 entry 018", value: 666 },
  { id: "order-2-019", label: "Order section 2 entry 019", value: 703 },
  { id: "order-2-020", label: "Order section 2 entry 020", value: 740 },
  { id: "order-2-021", label: "Order section 2 entry 021", value: 777 },
  { id: "order-2-022", label: "Order section 2 entry 022", value: 814 },
  { id: "order-2-023", label: "Order section 2 entry 023", value: 851 },
  { id: "order-2-024", label: "Order section 2 entry 024", value: 888 },
  { id: "order-2-025", label: "Order section 2 entry 025", value: 925 },
  { id: "order-2-026", label: "Order section 2 entry 026", value: 962 },
  { id: "order-2-027", label: "Order section 2 entry 027", value: 999 },
  { id: "order-2-028", label: "Order section 2 entry 028", value: 1036 },
  { id: "order-2-029", label: "Order section 2 entry 029", value: 1073 },
  { id: "order-2-030", label: "Order section 2 entry 030", value: 1110 },
  { id: "order-2-031", label: "Order section 2 entry 031", value: 1147 },
  { id: "order-2-032", label: "Order section 2 entry 032", value: 1184 },
  { id: "order-2-033", label: "Order section 2 entry 033", value: 1221 },
  { id: "order-2-034", label: "Order section 2 entry 034", value: 1258 },
  { id: "order-2-035", label: "Order section 2 entry 035", value: 1295 },
  { id: "order-2-036", label: "Order section 2 entry 036", value: 1332 },
  { id: "order-2-037", label: "Order section 2 entry 037", value: 1369 },
  { id: "order-2-038", label: "Order section 2 entry 038", value: 1406 },
  { id: "order-2-039", label: "Order section 2 entry 039", value: 1443 },
  { id: "order-2-040", label: "Order section 2 entry 040", value: 1480 },
  { id: "order-2-041", label: "Order section 2 entry 041", value: 1517 },
  { id: "order-2-042", label: "Order section 2 entry 042", value: 1554 },
  { id: "order-2-043", label: "Order section 2 entry 043", value: 1591 },
  { id: "order-2-044", label: "Order section 2 entry 044", value: 1628 },
  { id: "order-2-045", label: "Order section 2 entry 045", value: 1665 },
  { id: "order-2-046", label: "Order section 2 entry 046", value: 1702 },
  { id: "order-2-047", label: "Order section 2 entry 047", value: 1739 },
  { id: "order-2-048", label: "Order section 2 entry 048", value: 1776 },
  { id: "order-2-049", label: "Order section 2 entry 049", value: 1813 },
  { id: "order-2-050", label: "Order section 2 entry 050", value: 1850 },
  { id: "order-2-051", label: "Order section 2 entry 051", value: 1887 },
  { id: "order-2-052", label: "Order section 2 entry 052", value: 1924 },
  { id: "order-2-053", label: "Order section 2 entry 053", value: 1961 },
  { id: "order-2-054", label: "Order section 2 entry 054", value: 1998 },
  { id: "order-2-055", label: "Order section 2 entry 055", value: 2035 },
  { id: "order-2-056", label: "Order section 2 entry 056", value: 2072 },
  { id: "order-2-057", label: "Order section 2 entry 057", value: 2109 },
  { id: "order-2-058", label: "Order section 2 entry 058", value: 2146 },
  { id: "order-2-059", label: "Order section 2 entry 059", value: 2183 },
  { id: "order-2-060", label: "Order section 2 entry 060", value: 2220 },
];

// One of 6 sections of the order list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function OrderSection2() {
  return (
    <section className={styles.section} data-marker="marker-order-section-2">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
