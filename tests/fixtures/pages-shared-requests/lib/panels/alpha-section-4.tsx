import styles from "./alpha-section-4.module.css";

const ROWS = [
  { id: "alpha-4-001", label: "Alpha section 4 entry 001", value: 37 },
  { id: "alpha-4-002", label: "Alpha section 4 entry 002", value: 74 },
  { id: "alpha-4-003", label: "Alpha section 4 entry 003", value: 111 },
  { id: "alpha-4-004", label: "Alpha section 4 entry 004", value: 148 },
  { id: "alpha-4-005", label: "Alpha section 4 entry 005", value: 185 },
  { id: "alpha-4-006", label: "Alpha section 4 entry 006", value: 222 },
  { id: "alpha-4-007", label: "Alpha section 4 entry 007", value: 259 },
  { id: "alpha-4-008", label: "Alpha section 4 entry 008", value: 296 },
  { id: "alpha-4-009", label: "Alpha section 4 entry 009", value: 333 },
  { id: "alpha-4-010", label: "Alpha section 4 entry 010", value: 370 },
  { id: "alpha-4-011", label: "Alpha section 4 entry 011", value: 407 },
  { id: "alpha-4-012", label: "Alpha section 4 entry 012", value: 444 },
  { id: "alpha-4-013", label: "Alpha section 4 entry 013", value: 481 },
  { id: "alpha-4-014", label: "Alpha section 4 entry 014", value: 518 },
  { id: "alpha-4-015", label: "Alpha section 4 entry 015", value: 555 },
  { id: "alpha-4-016", label: "Alpha section 4 entry 016", value: 592 },
  { id: "alpha-4-017", label: "Alpha section 4 entry 017", value: 629 },
  { id: "alpha-4-018", label: "Alpha section 4 entry 018", value: 666 },
  { id: "alpha-4-019", label: "Alpha section 4 entry 019", value: 703 },
  { id: "alpha-4-020", label: "Alpha section 4 entry 020", value: 740 },
  { id: "alpha-4-021", label: "Alpha section 4 entry 021", value: 777 },
  { id: "alpha-4-022", label: "Alpha section 4 entry 022", value: 814 },
  { id: "alpha-4-023", label: "Alpha section 4 entry 023", value: 851 },
  { id: "alpha-4-024", label: "Alpha section 4 entry 024", value: 888 },
  { id: "alpha-4-025", label: "Alpha section 4 entry 025", value: 925 },
  { id: "alpha-4-026", label: "Alpha section 4 entry 026", value: 962 },
  { id: "alpha-4-027", label: "Alpha section 4 entry 027", value: 999 },
  { id: "alpha-4-028", label: "Alpha section 4 entry 028", value: 1036 },
  { id: "alpha-4-029", label: "Alpha section 4 entry 029", value: 1073 },
  { id: "alpha-4-030", label: "Alpha section 4 entry 030", value: 1110 },
  { id: "alpha-4-031", label: "Alpha section 4 entry 031", value: 1147 },
  { id: "alpha-4-032", label: "Alpha section 4 entry 032", value: 1184 },
  { id: "alpha-4-033", label: "Alpha section 4 entry 033", value: 1221 },
  { id: "alpha-4-034", label: "Alpha section 4 entry 034", value: 1258 },
  { id: "alpha-4-035", label: "Alpha section 4 entry 035", value: 1295 },
  { id: "alpha-4-036", label: "Alpha section 4 entry 036", value: 1332 },
  { id: "alpha-4-037", label: "Alpha section 4 entry 037", value: 1369 },
  { id: "alpha-4-038", label: "Alpha section 4 entry 038", value: 1406 },
  { id: "alpha-4-039", label: "Alpha section 4 entry 039", value: 1443 },
  { id: "alpha-4-040", label: "Alpha section 4 entry 040", value: 1480 },
  { id: "alpha-4-041", label: "Alpha section 4 entry 041", value: 1517 },
  { id: "alpha-4-042", label: "Alpha section 4 entry 042", value: 1554 },
  { id: "alpha-4-043", label: "Alpha section 4 entry 043", value: 1591 },
  { id: "alpha-4-044", label: "Alpha section 4 entry 044", value: 1628 },
  { id: "alpha-4-045", label: "Alpha section 4 entry 045", value: 1665 },
  { id: "alpha-4-046", label: "Alpha section 4 entry 046", value: 1702 },
  { id: "alpha-4-047", label: "Alpha section 4 entry 047", value: 1739 },
  { id: "alpha-4-048", label: "Alpha section 4 entry 048", value: 1776 },
  { id: "alpha-4-049", label: "Alpha section 4 entry 049", value: 1813 },
  { id: "alpha-4-050", label: "Alpha section 4 entry 050", value: 1850 },
  { id: "alpha-4-051", label: "Alpha section 4 entry 051", value: 1887 },
  { id: "alpha-4-052", label: "Alpha section 4 entry 052", value: 1924 },
  { id: "alpha-4-053", label: "Alpha section 4 entry 053", value: 1961 },
  { id: "alpha-4-054", label: "Alpha section 4 entry 054", value: 1998 },
  { id: "alpha-4-055", label: "Alpha section 4 entry 055", value: 2035 },
  { id: "alpha-4-056", label: "Alpha section 4 entry 056", value: 2072 },
  { id: "alpha-4-057", label: "Alpha section 4 entry 057", value: 2109 },
  { id: "alpha-4-058", label: "Alpha section 4 entry 058", value: 2146 },
  { id: "alpha-4-059", label: "Alpha section 4 entry 059", value: 2183 },
  { id: "alpha-4-060", label: "Alpha section 4 entry 060", value: 2220 },
];

// One of 6 sections of the alpha list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AlphaSection4() {
  return (
    <section className={styles.section} data-marker="marker-alpha-section-4">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
