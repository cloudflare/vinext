import { cardTitle } from "./card-title";
import styles from "./card-section-1.module.css";

const ROWS = [
  { id: "card-1-001", label: "Card section 1 entry 001", value: 37 },
  { id: "card-1-002", label: "Card section 1 entry 002", value: 74 },
  { id: "card-1-003", label: "Card section 1 entry 003", value: 111 },
  { id: "card-1-004", label: "Card section 1 entry 004", value: 148 },
  { id: "card-1-005", label: "Card section 1 entry 005", value: 185 },
  { id: "card-1-006", label: "Card section 1 entry 006", value: 222 },
  { id: "card-1-007", label: "Card section 1 entry 007", value: 259 },
  { id: "card-1-008", label: "Card section 1 entry 008", value: 296 },
  { id: "card-1-009", label: "Card section 1 entry 009", value: 333 },
  { id: "card-1-010", label: "Card section 1 entry 010", value: 370 },
  { id: "card-1-011", label: "Card section 1 entry 011", value: 407 },
  { id: "card-1-012", label: "Card section 1 entry 012", value: 444 },
  { id: "card-1-013", label: "Card section 1 entry 013", value: 481 },
  { id: "card-1-014", label: "Card section 1 entry 014", value: 518 },
  { id: "card-1-015", label: "Card section 1 entry 015", value: 555 },
  { id: "card-1-016", label: "Card section 1 entry 016", value: 592 },
  { id: "card-1-017", label: "Card section 1 entry 017", value: 629 },
  { id: "card-1-018", label: "Card section 1 entry 018", value: 666 },
  { id: "card-1-019", label: "Card section 1 entry 019", value: 703 },
  { id: "card-1-020", label: "Card section 1 entry 020", value: 740 },
  { id: "card-1-021", label: "Card section 1 entry 021", value: 777 },
  { id: "card-1-022", label: "Card section 1 entry 022", value: 814 },
  { id: "card-1-023", label: "Card section 1 entry 023", value: 851 },
  { id: "card-1-024", label: "Card section 1 entry 024", value: 888 },
  { id: "card-1-025", label: "Card section 1 entry 025", value: 925 },
  { id: "card-1-026", label: "Card section 1 entry 026", value: 962 },
  { id: "card-1-027", label: "Card section 1 entry 027", value: 999 },
  { id: "card-1-028", label: "Card section 1 entry 028", value: 1036 },
  { id: "card-1-029", label: "Card section 1 entry 029", value: 1073 },
  { id: "card-1-030", label: "Card section 1 entry 030", value: 1110 },
  { id: "card-1-031", label: "Card section 1 entry 031", value: 1147 },
  { id: "card-1-032", label: "Card section 1 entry 032", value: 1184 },
  { id: "card-1-033", label: "Card section 1 entry 033", value: 1221 },
  { id: "card-1-034", label: "Card section 1 entry 034", value: 1258 },
  { id: "card-1-035", label: "Card section 1 entry 035", value: 1295 },
  { id: "card-1-036", label: "Card section 1 entry 036", value: 1332 },
  { id: "card-1-037", label: "Card section 1 entry 037", value: 1369 },
  { id: "card-1-038", label: "Card section 1 entry 038", value: 1406 },
  { id: "card-1-039", label: "Card section 1 entry 039", value: 1443 },
  { id: "card-1-040", label: "Card section 1 entry 040", value: 1480 },
  { id: "card-1-041", label: "Card section 1 entry 041", value: 1517 },
  { id: "card-1-042", label: "Card section 1 entry 042", value: 1554 },
  { id: "card-1-043", label: "Card section 1 entry 043", value: 1591 },
  { id: "card-1-044", label: "Card section 1 entry 044", value: 1628 },
  { id: "card-1-045", label: "Card section 1 entry 045", value: 1665 },
  { id: "card-1-046", label: "Card section 1 entry 046", value: 1702 },
  { id: "card-1-047", label: "Card section 1 entry 047", value: 1739 },
  { id: "card-1-048", label: "Card section 1 entry 048", value: 1776 },
  { id: "card-1-049", label: "Card section 1 entry 049", value: 1813 },
  { id: "card-1-050", label: "Card section 1 entry 050", value: 1850 },
  { id: "card-1-051", label: "Card section 1 entry 051", value: 1887 },
  { id: "card-1-052", label: "Card section 1 entry 052", value: 1924 },
  { id: "card-1-053", label: "Card section 1 entry 053", value: 1961 },
  { id: "card-1-054", label: "Card section 1 entry 054", value: 1998 },
  { id: "card-1-055", label: "Card section 1 entry 055", value: 2035 },
  { id: "card-1-056", label: "Card section 1 entry 056", value: 2072 },
  { id: "card-1-057", label: "Card section 1 entry 057", value: 2109 },
  { id: "card-1-058", label: "Card section 1 entry 058", value: 2146 },
  { id: "card-1-059", label: "Card section 1 entry 059", value: 2183 },
  { id: "card-1-060", label: "Card section 1 entry 060", value: 2220 },
];

// One of 6 sections of the card list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function CardSection1() {
  return (
    <section className={styles.section} data-marker="marker-card-section-1">
      <span>{cardTitle(ROWS[0]!.label)}</span>
      <p>{ROWS.length}</p>
    </section>
  );
}
