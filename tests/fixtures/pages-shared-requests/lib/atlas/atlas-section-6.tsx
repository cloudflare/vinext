import styles from "./atlas-section-6.module.css";

const ROWS = [
  { id: "atlas-6-001", label: "Atlas section 6 entry 001", value: 37 },
  { id: "atlas-6-002", label: "Atlas section 6 entry 002", value: 74 },
  { id: "atlas-6-003", label: "Atlas section 6 entry 003", value: 111 },
  { id: "atlas-6-004", label: "Atlas section 6 entry 004", value: 148 },
  { id: "atlas-6-005", label: "Atlas section 6 entry 005", value: 185 },
  { id: "atlas-6-006", label: "Atlas section 6 entry 006", value: 222 },
  { id: "atlas-6-007", label: "Atlas section 6 entry 007", value: 259 },
  { id: "atlas-6-008", label: "Atlas section 6 entry 008", value: 296 },
  { id: "atlas-6-009", label: "Atlas section 6 entry 009", value: 333 },
  { id: "atlas-6-010", label: "Atlas section 6 entry 010", value: 370 },
  { id: "atlas-6-011", label: "Atlas section 6 entry 011", value: 407 },
  { id: "atlas-6-012", label: "Atlas section 6 entry 012", value: 444 },
  { id: "atlas-6-013", label: "Atlas section 6 entry 013", value: 481 },
  { id: "atlas-6-014", label: "Atlas section 6 entry 014", value: 518 },
  { id: "atlas-6-015", label: "Atlas section 6 entry 015", value: 555 },
  { id: "atlas-6-016", label: "Atlas section 6 entry 016", value: 592 },
  { id: "atlas-6-017", label: "Atlas section 6 entry 017", value: 629 },
  { id: "atlas-6-018", label: "Atlas section 6 entry 018", value: 666 },
  { id: "atlas-6-019", label: "Atlas section 6 entry 019", value: 703 },
  { id: "atlas-6-020", label: "Atlas section 6 entry 020", value: 740 },
  { id: "atlas-6-021", label: "Atlas section 6 entry 021", value: 777 },
  { id: "atlas-6-022", label: "Atlas section 6 entry 022", value: 814 },
  { id: "atlas-6-023", label: "Atlas section 6 entry 023", value: 851 },
  { id: "atlas-6-024", label: "Atlas section 6 entry 024", value: 888 },
  { id: "atlas-6-025", label: "Atlas section 6 entry 025", value: 925 },
  { id: "atlas-6-026", label: "Atlas section 6 entry 026", value: 962 },
  { id: "atlas-6-027", label: "Atlas section 6 entry 027", value: 999 },
  { id: "atlas-6-028", label: "Atlas section 6 entry 028", value: 1036 },
  { id: "atlas-6-029", label: "Atlas section 6 entry 029", value: 1073 },
  { id: "atlas-6-030", label: "Atlas section 6 entry 030", value: 1110 },
  { id: "atlas-6-031", label: "Atlas section 6 entry 031", value: 1147 },
  { id: "atlas-6-032", label: "Atlas section 6 entry 032", value: 1184 },
  { id: "atlas-6-033", label: "Atlas section 6 entry 033", value: 1221 },
  { id: "atlas-6-034", label: "Atlas section 6 entry 034", value: 1258 },
  { id: "atlas-6-035", label: "Atlas section 6 entry 035", value: 1295 },
  { id: "atlas-6-036", label: "Atlas section 6 entry 036", value: 1332 },
  { id: "atlas-6-037", label: "Atlas section 6 entry 037", value: 1369 },
  { id: "atlas-6-038", label: "Atlas section 6 entry 038", value: 1406 },
  { id: "atlas-6-039", label: "Atlas section 6 entry 039", value: 1443 },
  { id: "atlas-6-040", label: "Atlas section 6 entry 040", value: 1480 },
  { id: "atlas-6-041", label: "Atlas section 6 entry 041", value: 1517 },
  { id: "atlas-6-042", label: "Atlas section 6 entry 042", value: 1554 },
  { id: "atlas-6-043", label: "Atlas section 6 entry 043", value: 1591 },
  { id: "atlas-6-044", label: "Atlas section 6 entry 044", value: 1628 },
  { id: "atlas-6-045", label: "Atlas section 6 entry 045", value: 1665 },
  { id: "atlas-6-046", label: "Atlas section 6 entry 046", value: 1702 },
  { id: "atlas-6-047", label: "Atlas section 6 entry 047", value: 1739 },
  { id: "atlas-6-048", label: "Atlas section 6 entry 048", value: 1776 },
  { id: "atlas-6-049", label: "Atlas section 6 entry 049", value: 1813 },
  { id: "atlas-6-050", label: "Atlas section 6 entry 050", value: 1850 },
  { id: "atlas-6-051", label: "Atlas section 6 entry 051", value: 1887 },
  { id: "atlas-6-052", label: "Atlas section 6 entry 052", value: 1924 },
  { id: "atlas-6-053", label: "Atlas section 6 entry 053", value: 1961 },
  { id: "atlas-6-054", label: "Atlas section 6 entry 054", value: 1998 },
  { id: "atlas-6-055", label: "Atlas section 6 entry 055", value: 2035 },
  { id: "atlas-6-056", label: "Atlas section 6 entry 056", value: 2072 },
  { id: "atlas-6-057", label: "Atlas section 6 entry 057", value: 2109 },
  { id: "atlas-6-058", label: "Atlas section 6 entry 058", value: 2146 },
  { id: "atlas-6-059", label: "Atlas section 6 entry 059", value: 2183 },
  { id: "atlas-6-060", label: "Atlas section 6 entry 060", value: 2220 },
];

// One of 6 sections of the atlas list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AtlasSection6() {
  return (
    <section className={styles.section} data-marker="marker-atlas-section-6">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
