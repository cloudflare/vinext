import styles from "./atlas-section-4.module.css";

const ROWS = [
  { id: "atlas-4-001", label: "Atlas section 4 entry 001", value: 37 },
  { id: "atlas-4-002", label: "Atlas section 4 entry 002", value: 74 },
  { id: "atlas-4-003", label: "Atlas section 4 entry 003", value: 111 },
  { id: "atlas-4-004", label: "Atlas section 4 entry 004", value: 148 },
  { id: "atlas-4-005", label: "Atlas section 4 entry 005", value: 185 },
  { id: "atlas-4-006", label: "Atlas section 4 entry 006", value: 222 },
  { id: "atlas-4-007", label: "Atlas section 4 entry 007", value: 259 },
  { id: "atlas-4-008", label: "Atlas section 4 entry 008", value: 296 },
  { id: "atlas-4-009", label: "Atlas section 4 entry 009", value: 333 },
  { id: "atlas-4-010", label: "Atlas section 4 entry 010", value: 370 },
  { id: "atlas-4-011", label: "Atlas section 4 entry 011", value: 407 },
  { id: "atlas-4-012", label: "Atlas section 4 entry 012", value: 444 },
  { id: "atlas-4-013", label: "Atlas section 4 entry 013", value: 481 },
  { id: "atlas-4-014", label: "Atlas section 4 entry 014", value: 518 },
  { id: "atlas-4-015", label: "Atlas section 4 entry 015", value: 555 },
  { id: "atlas-4-016", label: "Atlas section 4 entry 016", value: 592 },
  { id: "atlas-4-017", label: "Atlas section 4 entry 017", value: 629 },
  { id: "atlas-4-018", label: "Atlas section 4 entry 018", value: 666 },
  { id: "atlas-4-019", label: "Atlas section 4 entry 019", value: 703 },
  { id: "atlas-4-020", label: "Atlas section 4 entry 020", value: 740 },
  { id: "atlas-4-021", label: "Atlas section 4 entry 021", value: 777 },
  { id: "atlas-4-022", label: "Atlas section 4 entry 022", value: 814 },
  { id: "atlas-4-023", label: "Atlas section 4 entry 023", value: 851 },
  { id: "atlas-4-024", label: "Atlas section 4 entry 024", value: 888 },
  { id: "atlas-4-025", label: "Atlas section 4 entry 025", value: 925 },
  { id: "atlas-4-026", label: "Atlas section 4 entry 026", value: 962 },
  { id: "atlas-4-027", label: "Atlas section 4 entry 027", value: 999 },
  { id: "atlas-4-028", label: "Atlas section 4 entry 028", value: 1036 },
  { id: "atlas-4-029", label: "Atlas section 4 entry 029", value: 1073 },
  { id: "atlas-4-030", label: "Atlas section 4 entry 030", value: 1110 },
  { id: "atlas-4-031", label: "Atlas section 4 entry 031", value: 1147 },
  { id: "atlas-4-032", label: "Atlas section 4 entry 032", value: 1184 },
  { id: "atlas-4-033", label: "Atlas section 4 entry 033", value: 1221 },
  { id: "atlas-4-034", label: "Atlas section 4 entry 034", value: 1258 },
  { id: "atlas-4-035", label: "Atlas section 4 entry 035", value: 1295 },
  { id: "atlas-4-036", label: "Atlas section 4 entry 036", value: 1332 },
  { id: "atlas-4-037", label: "Atlas section 4 entry 037", value: 1369 },
  { id: "atlas-4-038", label: "Atlas section 4 entry 038", value: 1406 },
  { id: "atlas-4-039", label: "Atlas section 4 entry 039", value: 1443 },
  { id: "atlas-4-040", label: "Atlas section 4 entry 040", value: 1480 },
  { id: "atlas-4-041", label: "Atlas section 4 entry 041", value: 1517 },
  { id: "atlas-4-042", label: "Atlas section 4 entry 042", value: 1554 },
  { id: "atlas-4-043", label: "Atlas section 4 entry 043", value: 1591 },
  { id: "atlas-4-044", label: "Atlas section 4 entry 044", value: 1628 },
  { id: "atlas-4-045", label: "Atlas section 4 entry 045", value: 1665 },
  { id: "atlas-4-046", label: "Atlas section 4 entry 046", value: 1702 },
  { id: "atlas-4-047", label: "Atlas section 4 entry 047", value: 1739 },
  { id: "atlas-4-048", label: "Atlas section 4 entry 048", value: 1776 },
  { id: "atlas-4-049", label: "Atlas section 4 entry 049", value: 1813 },
  { id: "atlas-4-050", label: "Atlas section 4 entry 050", value: 1850 },
  { id: "atlas-4-051", label: "Atlas section 4 entry 051", value: 1887 },
  { id: "atlas-4-052", label: "Atlas section 4 entry 052", value: 1924 },
  { id: "atlas-4-053", label: "Atlas section 4 entry 053", value: 1961 },
  { id: "atlas-4-054", label: "Atlas section 4 entry 054", value: 1998 },
  { id: "atlas-4-055", label: "Atlas section 4 entry 055", value: 2035 },
  { id: "atlas-4-056", label: "Atlas section 4 entry 056", value: 2072 },
  { id: "atlas-4-057", label: "Atlas section 4 entry 057", value: 2109 },
  { id: "atlas-4-058", label: "Atlas section 4 entry 058", value: 2146 },
  { id: "atlas-4-059", label: "Atlas section 4 entry 059", value: 2183 },
  { id: "atlas-4-060", label: "Atlas section 4 entry 060", value: 2220 },
];

// One of 6 sections of the atlas list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AtlasSection4() {
  return (
    <section className={styles.section} data-marker="marker-atlas-section-4">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
