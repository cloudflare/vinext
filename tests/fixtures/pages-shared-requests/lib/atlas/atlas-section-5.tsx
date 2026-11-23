import styles from "./atlas-section-5.module.css";

const ROWS = [
  { id: "atlas-5-001", label: "Atlas section 5 entry 001", value: 37 },
  { id: "atlas-5-002", label: "Atlas section 5 entry 002", value: 74 },
  { id: "atlas-5-003", label: "Atlas section 5 entry 003", value: 111 },
  { id: "atlas-5-004", label: "Atlas section 5 entry 004", value: 148 },
  { id: "atlas-5-005", label: "Atlas section 5 entry 005", value: 185 },
  { id: "atlas-5-006", label: "Atlas section 5 entry 006", value: 222 },
  { id: "atlas-5-007", label: "Atlas section 5 entry 007", value: 259 },
  { id: "atlas-5-008", label: "Atlas section 5 entry 008", value: 296 },
  { id: "atlas-5-009", label: "Atlas section 5 entry 009", value: 333 },
  { id: "atlas-5-010", label: "Atlas section 5 entry 010", value: 370 },
  { id: "atlas-5-011", label: "Atlas section 5 entry 011", value: 407 },
  { id: "atlas-5-012", label: "Atlas section 5 entry 012", value: 444 },
  { id: "atlas-5-013", label: "Atlas section 5 entry 013", value: 481 },
  { id: "atlas-5-014", label: "Atlas section 5 entry 014", value: 518 },
  { id: "atlas-5-015", label: "Atlas section 5 entry 015", value: 555 },
  { id: "atlas-5-016", label: "Atlas section 5 entry 016", value: 592 },
  { id: "atlas-5-017", label: "Atlas section 5 entry 017", value: 629 },
  { id: "atlas-5-018", label: "Atlas section 5 entry 018", value: 666 },
  { id: "atlas-5-019", label: "Atlas section 5 entry 019", value: 703 },
  { id: "atlas-5-020", label: "Atlas section 5 entry 020", value: 740 },
  { id: "atlas-5-021", label: "Atlas section 5 entry 021", value: 777 },
  { id: "atlas-5-022", label: "Atlas section 5 entry 022", value: 814 },
  { id: "atlas-5-023", label: "Atlas section 5 entry 023", value: 851 },
  { id: "atlas-5-024", label: "Atlas section 5 entry 024", value: 888 },
  { id: "atlas-5-025", label: "Atlas section 5 entry 025", value: 925 },
  { id: "atlas-5-026", label: "Atlas section 5 entry 026", value: 962 },
  { id: "atlas-5-027", label: "Atlas section 5 entry 027", value: 999 },
  { id: "atlas-5-028", label: "Atlas section 5 entry 028", value: 1036 },
  { id: "atlas-5-029", label: "Atlas section 5 entry 029", value: 1073 },
  { id: "atlas-5-030", label: "Atlas section 5 entry 030", value: 1110 },
  { id: "atlas-5-031", label: "Atlas section 5 entry 031", value: 1147 },
  { id: "atlas-5-032", label: "Atlas section 5 entry 032", value: 1184 },
  { id: "atlas-5-033", label: "Atlas section 5 entry 033", value: 1221 },
  { id: "atlas-5-034", label: "Atlas section 5 entry 034", value: 1258 },
  { id: "atlas-5-035", label: "Atlas section 5 entry 035", value: 1295 },
  { id: "atlas-5-036", label: "Atlas section 5 entry 036", value: 1332 },
  { id: "atlas-5-037", label: "Atlas section 5 entry 037", value: 1369 },
  { id: "atlas-5-038", label: "Atlas section 5 entry 038", value: 1406 },
  { id: "atlas-5-039", label: "Atlas section 5 entry 039", value: 1443 },
  { id: "atlas-5-040", label: "Atlas section 5 entry 040", value: 1480 },
  { id: "atlas-5-041", label: "Atlas section 5 entry 041", value: 1517 },
  { id: "atlas-5-042", label: "Atlas section 5 entry 042", value: 1554 },
  { id: "atlas-5-043", label: "Atlas section 5 entry 043", value: 1591 },
  { id: "atlas-5-044", label: "Atlas section 5 entry 044", value: 1628 },
  { id: "atlas-5-045", label: "Atlas section 5 entry 045", value: 1665 },
  { id: "atlas-5-046", label: "Atlas section 5 entry 046", value: 1702 },
  { id: "atlas-5-047", label: "Atlas section 5 entry 047", value: 1739 },
  { id: "atlas-5-048", label: "Atlas section 5 entry 048", value: 1776 },
  { id: "atlas-5-049", label: "Atlas section 5 entry 049", value: 1813 },
  { id: "atlas-5-050", label: "Atlas section 5 entry 050", value: 1850 },
  { id: "atlas-5-051", label: "Atlas section 5 entry 051", value: 1887 },
  { id: "atlas-5-052", label: "Atlas section 5 entry 052", value: 1924 },
  { id: "atlas-5-053", label: "Atlas section 5 entry 053", value: 1961 },
  { id: "atlas-5-054", label: "Atlas section 5 entry 054", value: 1998 },
  { id: "atlas-5-055", label: "Atlas section 5 entry 055", value: 2035 },
  { id: "atlas-5-056", label: "Atlas section 5 entry 056", value: 2072 },
  { id: "atlas-5-057", label: "Atlas section 5 entry 057", value: 2109 },
  { id: "atlas-5-058", label: "Atlas section 5 entry 058", value: 2146 },
  { id: "atlas-5-059", label: "Atlas section 5 entry 059", value: 2183 },
  { id: "atlas-5-060", label: "Atlas section 5 entry 060", value: 2220 },
];

// One of 6 sections of the atlas list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AtlasSection5() {
  return (
    <section className={styles.section} data-marker="marker-atlas-section-5">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
