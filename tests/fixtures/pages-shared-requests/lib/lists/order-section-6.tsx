import { Label } from "./label";
import styles from "./order-section-6.module.css";

const ROWS = [
  { id: "order-6-001", label: "Order section 6 entry 001", value: 37 },
  { id: "order-6-002", label: "Order section 6 entry 002", value: 74 },
  { id: "order-6-003", label: "Order section 6 entry 003", value: 111 },
  { id: "order-6-004", label: "Order section 6 entry 004", value: 148 },
  { id: "order-6-005", label: "Order section 6 entry 005", value: 185 },
  { id: "order-6-006", label: "Order section 6 entry 006", value: 222 },
  { id: "order-6-007", label: "Order section 6 entry 007", value: 259 },
  { id: "order-6-008", label: "Order section 6 entry 008", value: 296 },
  { id: "order-6-009", label: "Order section 6 entry 009", value: 333 },
  { id: "order-6-010", label: "Order section 6 entry 010", value: 370 },
  { id: "order-6-011", label: "Order section 6 entry 011", value: 407 },
  { id: "order-6-012", label: "Order section 6 entry 012", value: 444 },
  { id: "order-6-013", label: "Order section 6 entry 013", value: 481 },
  { id: "order-6-014", label: "Order section 6 entry 014", value: 518 },
  { id: "order-6-015", label: "Order section 6 entry 015", value: 555 },
  { id: "order-6-016", label: "Order section 6 entry 016", value: 592 },
  { id: "order-6-017", label: "Order section 6 entry 017", value: 629 },
  { id: "order-6-018", label: "Order section 6 entry 018", value: 666 },
  { id: "order-6-019", label: "Order section 6 entry 019", value: 703 },
  { id: "order-6-020", label: "Order section 6 entry 020", value: 740 },
  { id: "order-6-021", label: "Order section 6 entry 021", value: 777 },
  { id: "order-6-022", label: "Order section 6 entry 022", value: 814 },
  { id: "order-6-023", label: "Order section 6 entry 023", value: 851 },
  { id: "order-6-024", label: "Order section 6 entry 024", value: 888 },
  { id: "order-6-025", label: "Order section 6 entry 025", value: 925 },
  { id: "order-6-026", label: "Order section 6 entry 026", value: 962 },
  { id: "order-6-027", label: "Order section 6 entry 027", value: 999 },
  { id: "order-6-028", label: "Order section 6 entry 028", value: 1036 },
  { id: "order-6-029", label: "Order section 6 entry 029", value: 1073 },
  { id: "order-6-030", label: "Order section 6 entry 030", value: 1110 },
  { id: "order-6-031", label: "Order section 6 entry 031", value: 1147 },
  { id: "order-6-032", label: "Order section 6 entry 032", value: 1184 },
  { id: "order-6-033", label: "Order section 6 entry 033", value: 1221 },
  { id: "order-6-034", label: "Order section 6 entry 034", value: 1258 },
  { id: "order-6-035", label: "Order section 6 entry 035", value: 1295 },
  { id: "order-6-036", label: "Order section 6 entry 036", value: 1332 },
  { id: "order-6-037", label: "Order section 6 entry 037", value: 1369 },
  { id: "order-6-038", label: "Order section 6 entry 038", value: 1406 },
  { id: "order-6-039", label: "Order section 6 entry 039", value: 1443 },
  { id: "order-6-040", label: "Order section 6 entry 040", value: 1480 },
  { id: "order-6-041", label: "Order section 6 entry 041", value: 1517 },
  { id: "order-6-042", label: "Order section 6 entry 042", value: 1554 },
  { id: "order-6-043", label: "Order section 6 entry 043", value: 1591 },
  { id: "order-6-044", label: "Order section 6 entry 044", value: 1628 },
  { id: "order-6-045", label: "Order section 6 entry 045", value: 1665 },
  { id: "order-6-046", label: "Order section 6 entry 046", value: 1702 },
  { id: "order-6-047", label: "Order section 6 entry 047", value: 1739 },
  { id: "order-6-048", label: "Order section 6 entry 048", value: 1776 },
  { id: "order-6-049", label: "Order section 6 entry 049", value: 1813 },
  { id: "order-6-050", label: "Order section 6 entry 050", value: 1850 },
  { id: "order-6-051", label: "Order section 6 entry 051", value: 1887 },
  { id: "order-6-052", label: "Order section 6 entry 052", value: 1924 },
  { id: "order-6-053", label: "Order section 6 entry 053", value: 1961 },
  { id: "order-6-054", label: "Order section 6 entry 054", value: 1998 },
  { id: "order-6-055", label: "Order section 6 entry 055", value: 2035 },
  { id: "order-6-056", label: "Order section 6 entry 056", value: 2072 },
  { id: "order-6-057", label: "Order section 6 entry 057", value: 2109 },
  { id: "order-6-058", label: "Order section 6 entry 058", value: 2146 },
  { id: "order-6-059", label: "Order section 6 entry 059", value: 2183 },
  { id: "order-6-060", label: "Order section 6 entry 060", value: 2220 },
];

// One of 6 sections of the order list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function OrderSection6() {
  return (
    <section className={styles.section} data-marker="marker-order-section-6">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
