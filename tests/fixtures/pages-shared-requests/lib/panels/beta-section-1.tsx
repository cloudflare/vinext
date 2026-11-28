import styles from "./beta-section-1.module.css";

const ROWS = [
  { id: "beta-1-001", label: "Beta section 1 entry 001", value: 37 },
  { id: "beta-1-002", label: "Beta section 1 entry 002", value: 74 },
  { id: "beta-1-003", label: "Beta section 1 entry 003", value: 111 },
  { id: "beta-1-004", label: "Beta section 1 entry 004", value: 148 },
  { id: "beta-1-005", label: "Beta section 1 entry 005", value: 185 },
  { id: "beta-1-006", label: "Beta section 1 entry 006", value: 222 },
  { id: "beta-1-007", label: "Beta section 1 entry 007", value: 259 },
  { id: "beta-1-008", label: "Beta section 1 entry 008", value: 296 },
  { id: "beta-1-009", label: "Beta section 1 entry 009", value: 333 },
  { id: "beta-1-010", label: "Beta section 1 entry 010", value: 370 },
  { id: "beta-1-011", label: "Beta section 1 entry 011", value: 407 },
  { id: "beta-1-012", label: "Beta section 1 entry 012", value: 444 },
  { id: "beta-1-013", label: "Beta section 1 entry 013", value: 481 },
  { id: "beta-1-014", label: "Beta section 1 entry 014", value: 518 },
  { id: "beta-1-015", label: "Beta section 1 entry 015", value: 555 },
  { id: "beta-1-016", label: "Beta section 1 entry 016", value: 592 },
  { id: "beta-1-017", label: "Beta section 1 entry 017", value: 629 },
  { id: "beta-1-018", label: "Beta section 1 entry 018", value: 666 },
  { id: "beta-1-019", label: "Beta section 1 entry 019", value: 703 },
  { id: "beta-1-020", label: "Beta section 1 entry 020", value: 740 },
  { id: "beta-1-021", label: "Beta section 1 entry 021", value: 777 },
  { id: "beta-1-022", label: "Beta section 1 entry 022", value: 814 },
  { id: "beta-1-023", label: "Beta section 1 entry 023", value: 851 },
  { id: "beta-1-024", label: "Beta section 1 entry 024", value: 888 },
  { id: "beta-1-025", label: "Beta section 1 entry 025", value: 925 },
  { id: "beta-1-026", label: "Beta section 1 entry 026", value: 962 },
  { id: "beta-1-027", label: "Beta section 1 entry 027", value: 999 },
  { id: "beta-1-028", label: "Beta section 1 entry 028", value: 1036 },
  { id: "beta-1-029", label: "Beta section 1 entry 029", value: 1073 },
  { id: "beta-1-030", label: "Beta section 1 entry 030", value: 1110 },
  { id: "beta-1-031", label: "Beta section 1 entry 031", value: 1147 },
  { id: "beta-1-032", label: "Beta section 1 entry 032", value: 1184 },
  { id: "beta-1-033", label: "Beta section 1 entry 033", value: 1221 },
  { id: "beta-1-034", label: "Beta section 1 entry 034", value: 1258 },
  { id: "beta-1-035", label: "Beta section 1 entry 035", value: 1295 },
  { id: "beta-1-036", label: "Beta section 1 entry 036", value: 1332 },
  { id: "beta-1-037", label: "Beta section 1 entry 037", value: 1369 },
  { id: "beta-1-038", label: "Beta section 1 entry 038", value: 1406 },
  { id: "beta-1-039", label: "Beta section 1 entry 039", value: 1443 },
  { id: "beta-1-040", label: "Beta section 1 entry 040", value: 1480 },
  { id: "beta-1-041", label: "Beta section 1 entry 041", value: 1517 },
  { id: "beta-1-042", label: "Beta section 1 entry 042", value: 1554 },
  { id: "beta-1-043", label: "Beta section 1 entry 043", value: 1591 },
  { id: "beta-1-044", label: "Beta section 1 entry 044", value: 1628 },
  { id: "beta-1-045", label: "Beta section 1 entry 045", value: 1665 },
  { id: "beta-1-046", label: "Beta section 1 entry 046", value: 1702 },
  { id: "beta-1-047", label: "Beta section 1 entry 047", value: 1739 },
  { id: "beta-1-048", label: "Beta section 1 entry 048", value: 1776 },
  { id: "beta-1-049", label: "Beta section 1 entry 049", value: 1813 },
  { id: "beta-1-050", label: "Beta section 1 entry 050", value: 1850 },
  { id: "beta-1-051", label: "Beta section 1 entry 051", value: 1887 },
  { id: "beta-1-052", label: "Beta section 1 entry 052", value: 1924 },
  { id: "beta-1-053", label: "Beta section 1 entry 053", value: 1961 },
  { id: "beta-1-054", label: "Beta section 1 entry 054", value: 1998 },
  { id: "beta-1-055", label: "Beta section 1 entry 055", value: 2035 },
  { id: "beta-1-056", label: "Beta section 1 entry 056", value: 2072 },
  { id: "beta-1-057", label: "Beta section 1 entry 057", value: 2109 },
  { id: "beta-1-058", label: "Beta section 1 entry 058", value: 2146 },
  { id: "beta-1-059", label: "Beta section 1 entry 059", value: 2183 },
  { id: "beta-1-060", label: "Beta section 1 entry 060", value: 2220 },
];

// One of 6 sections of the beta list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function BetaSection1() {
  return (
    <section className={styles.section} data-marker="marker-beta-section-1">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
