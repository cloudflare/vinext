import styles from "./alpha-section-5.module.css";

const ROWS = [
  { id: "alpha-5-001", label: "Alpha section 5 entry 001", value: 37 },
  { id: "alpha-5-002", label: "Alpha section 5 entry 002", value: 74 },
  { id: "alpha-5-003", label: "Alpha section 5 entry 003", value: 111 },
  { id: "alpha-5-004", label: "Alpha section 5 entry 004", value: 148 },
  { id: "alpha-5-005", label: "Alpha section 5 entry 005", value: 185 },
  { id: "alpha-5-006", label: "Alpha section 5 entry 006", value: 222 },
  { id: "alpha-5-007", label: "Alpha section 5 entry 007", value: 259 },
  { id: "alpha-5-008", label: "Alpha section 5 entry 008", value: 296 },
  { id: "alpha-5-009", label: "Alpha section 5 entry 009", value: 333 },
  { id: "alpha-5-010", label: "Alpha section 5 entry 010", value: 370 },
  { id: "alpha-5-011", label: "Alpha section 5 entry 011", value: 407 },
  { id: "alpha-5-012", label: "Alpha section 5 entry 012", value: 444 },
  { id: "alpha-5-013", label: "Alpha section 5 entry 013", value: 481 },
  { id: "alpha-5-014", label: "Alpha section 5 entry 014", value: 518 },
  { id: "alpha-5-015", label: "Alpha section 5 entry 015", value: 555 },
  { id: "alpha-5-016", label: "Alpha section 5 entry 016", value: 592 },
  { id: "alpha-5-017", label: "Alpha section 5 entry 017", value: 629 },
  { id: "alpha-5-018", label: "Alpha section 5 entry 018", value: 666 },
  { id: "alpha-5-019", label: "Alpha section 5 entry 019", value: 703 },
  { id: "alpha-5-020", label: "Alpha section 5 entry 020", value: 740 },
  { id: "alpha-5-021", label: "Alpha section 5 entry 021", value: 777 },
  { id: "alpha-5-022", label: "Alpha section 5 entry 022", value: 814 },
  { id: "alpha-5-023", label: "Alpha section 5 entry 023", value: 851 },
  { id: "alpha-5-024", label: "Alpha section 5 entry 024", value: 888 },
  { id: "alpha-5-025", label: "Alpha section 5 entry 025", value: 925 },
  { id: "alpha-5-026", label: "Alpha section 5 entry 026", value: 962 },
  { id: "alpha-5-027", label: "Alpha section 5 entry 027", value: 999 },
  { id: "alpha-5-028", label: "Alpha section 5 entry 028", value: 1036 },
  { id: "alpha-5-029", label: "Alpha section 5 entry 029", value: 1073 },
  { id: "alpha-5-030", label: "Alpha section 5 entry 030", value: 1110 },
  { id: "alpha-5-031", label: "Alpha section 5 entry 031", value: 1147 },
  { id: "alpha-5-032", label: "Alpha section 5 entry 032", value: 1184 },
  { id: "alpha-5-033", label: "Alpha section 5 entry 033", value: 1221 },
  { id: "alpha-5-034", label: "Alpha section 5 entry 034", value: 1258 },
  { id: "alpha-5-035", label: "Alpha section 5 entry 035", value: 1295 },
  { id: "alpha-5-036", label: "Alpha section 5 entry 036", value: 1332 },
  { id: "alpha-5-037", label: "Alpha section 5 entry 037", value: 1369 },
  { id: "alpha-5-038", label: "Alpha section 5 entry 038", value: 1406 },
  { id: "alpha-5-039", label: "Alpha section 5 entry 039", value: 1443 },
  { id: "alpha-5-040", label: "Alpha section 5 entry 040", value: 1480 },
  { id: "alpha-5-041", label: "Alpha section 5 entry 041", value: 1517 },
  { id: "alpha-5-042", label: "Alpha section 5 entry 042", value: 1554 },
  { id: "alpha-5-043", label: "Alpha section 5 entry 043", value: 1591 },
  { id: "alpha-5-044", label: "Alpha section 5 entry 044", value: 1628 },
  { id: "alpha-5-045", label: "Alpha section 5 entry 045", value: 1665 },
  { id: "alpha-5-046", label: "Alpha section 5 entry 046", value: 1702 },
  { id: "alpha-5-047", label: "Alpha section 5 entry 047", value: 1739 },
  { id: "alpha-5-048", label: "Alpha section 5 entry 048", value: 1776 },
  { id: "alpha-5-049", label: "Alpha section 5 entry 049", value: 1813 },
  { id: "alpha-5-050", label: "Alpha section 5 entry 050", value: 1850 },
  { id: "alpha-5-051", label: "Alpha section 5 entry 051", value: 1887 },
  { id: "alpha-5-052", label: "Alpha section 5 entry 052", value: 1924 },
  { id: "alpha-5-053", label: "Alpha section 5 entry 053", value: 1961 },
  { id: "alpha-5-054", label: "Alpha section 5 entry 054", value: 1998 },
  { id: "alpha-5-055", label: "Alpha section 5 entry 055", value: 2035 },
  { id: "alpha-5-056", label: "Alpha section 5 entry 056", value: 2072 },
  { id: "alpha-5-057", label: "Alpha section 5 entry 057", value: 2109 },
  { id: "alpha-5-058", label: "Alpha section 5 entry 058", value: 2146 },
  { id: "alpha-5-059", label: "Alpha section 5 entry 059", value: 2183 },
  { id: "alpha-5-060", label: "Alpha section 5 entry 060", value: 2220 },
];

// One of 6 sections of the alpha list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AlphaSection5() {
  return (
    <section className={styles.section} data-marker="marker-alpha-section-5">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
