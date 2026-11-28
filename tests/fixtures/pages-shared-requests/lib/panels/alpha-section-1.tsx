import styles from "./alpha-section-1.module.css";

const ROWS = [
  { id: "alpha-1-001", label: "Alpha section 1 entry 001", value: 37 },
  { id: "alpha-1-002", label: "Alpha section 1 entry 002", value: 74 },
  { id: "alpha-1-003", label: "Alpha section 1 entry 003", value: 111 },
  { id: "alpha-1-004", label: "Alpha section 1 entry 004", value: 148 },
  { id: "alpha-1-005", label: "Alpha section 1 entry 005", value: 185 },
  { id: "alpha-1-006", label: "Alpha section 1 entry 006", value: 222 },
  { id: "alpha-1-007", label: "Alpha section 1 entry 007", value: 259 },
  { id: "alpha-1-008", label: "Alpha section 1 entry 008", value: 296 },
  { id: "alpha-1-009", label: "Alpha section 1 entry 009", value: 333 },
  { id: "alpha-1-010", label: "Alpha section 1 entry 010", value: 370 },
  { id: "alpha-1-011", label: "Alpha section 1 entry 011", value: 407 },
  { id: "alpha-1-012", label: "Alpha section 1 entry 012", value: 444 },
  { id: "alpha-1-013", label: "Alpha section 1 entry 013", value: 481 },
  { id: "alpha-1-014", label: "Alpha section 1 entry 014", value: 518 },
  { id: "alpha-1-015", label: "Alpha section 1 entry 015", value: 555 },
  { id: "alpha-1-016", label: "Alpha section 1 entry 016", value: 592 },
  { id: "alpha-1-017", label: "Alpha section 1 entry 017", value: 629 },
  { id: "alpha-1-018", label: "Alpha section 1 entry 018", value: 666 },
  { id: "alpha-1-019", label: "Alpha section 1 entry 019", value: 703 },
  { id: "alpha-1-020", label: "Alpha section 1 entry 020", value: 740 },
  { id: "alpha-1-021", label: "Alpha section 1 entry 021", value: 777 },
  { id: "alpha-1-022", label: "Alpha section 1 entry 022", value: 814 },
  { id: "alpha-1-023", label: "Alpha section 1 entry 023", value: 851 },
  { id: "alpha-1-024", label: "Alpha section 1 entry 024", value: 888 },
  { id: "alpha-1-025", label: "Alpha section 1 entry 025", value: 925 },
  { id: "alpha-1-026", label: "Alpha section 1 entry 026", value: 962 },
  { id: "alpha-1-027", label: "Alpha section 1 entry 027", value: 999 },
  { id: "alpha-1-028", label: "Alpha section 1 entry 028", value: 1036 },
  { id: "alpha-1-029", label: "Alpha section 1 entry 029", value: 1073 },
  { id: "alpha-1-030", label: "Alpha section 1 entry 030", value: 1110 },
  { id: "alpha-1-031", label: "Alpha section 1 entry 031", value: 1147 },
  { id: "alpha-1-032", label: "Alpha section 1 entry 032", value: 1184 },
  { id: "alpha-1-033", label: "Alpha section 1 entry 033", value: 1221 },
  { id: "alpha-1-034", label: "Alpha section 1 entry 034", value: 1258 },
  { id: "alpha-1-035", label: "Alpha section 1 entry 035", value: 1295 },
  { id: "alpha-1-036", label: "Alpha section 1 entry 036", value: 1332 },
  { id: "alpha-1-037", label: "Alpha section 1 entry 037", value: 1369 },
  { id: "alpha-1-038", label: "Alpha section 1 entry 038", value: 1406 },
  { id: "alpha-1-039", label: "Alpha section 1 entry 039", value: 1443 },
  { id: "alpha-1-040", label: "Alpha section 1 entry 040", value: 1480 },
  { id: "alpha-1-041", label: "Alpha section 1 entry 041", value: 1517 },
  { id: "alpha-1-042", label: "Alpha section 1 entry 042", value: 1554 },
  { id: "alpha-1-043", label: "Alpha section 1 entry 043", value: 1591 },
  { id: "alpha-1-044", label: "Alpha section 1 entry 044", value: 1628 },
  { id: "alpha-1-045", label: "Alpha section 1 entry 045", value: 1665 },
  { id: "alpha-1-046", label: "Alpha section 1 entry 046", value: 1702 },
  { id: "alpha-1-047", label: "Alpha section 1 entry 047", value: 1739 },
  { id: "alpha-1-048", label: "Alpha section 1 entry 048", value: 1776 },
  { id: "alpha-1-049", label: "Alpha section 1 entry 049", value: 1813 },
  { id: "alpha-1-050", label: "Alpha section 1 entry 050", value: 1850 },
  { id: "alpha-1-051", label: "Alpha section 1 entry 051", value: 1887 },
  { id: "alpha-1-052", label: "Alpha section 1 entry 052", value: 1924 },
  { id: "alpha-1-053", label: "Alpha section 1 entry 053", value: 1961 },
  { id: "alpha-1-054", label: "Alpha section 1 entry 054", value: 1998 },
  { id: "alpha-1-055", label: "Alpha section 1 entry 055", value: 2035 },
  { id: "alpha-1-056", label: "Alpha section 1 entry 056", value: 2072 },
  { id: "alpha-1-057", label: "Alpha section 1 entry 057", value: 2109 },
  { id: "alpha-1-058", label: "Alpha section 1 entry 058", value: 2146 },
  { id: "alpha-1-059", label: "Alpha section 1 entry 059", value: 2183 },
  { id: "alpha-1-060", label: "Alpha section 1 entry 060", value: 2220 },
];

// One of 6 sections of the alpha list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AlphaSection1() {
  return (
    <section className={styles.section} data-marker="marker-alpha-section-1">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
