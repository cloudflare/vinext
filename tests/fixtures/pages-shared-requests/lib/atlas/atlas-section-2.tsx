import styles from "./atlas-section-2.module.css";

const ROWS = [
  { id: "atlas-2-001", label: "Atlas section 2 entry 001", value: 37 },
  { id: "atlas-2-002", label: "Atlas section 2 entry 002", value: 74 },
  { id: "atlas-2-003", label: "Atlas section 2 entry 003", value: 111 },
  { id: "atlas-2-004", label: "Atlas section 2 entry 004", value: 148 },
  { id: "atlas-2-005", label: "Atlas section 2 entry 005", value: 185 },
  { id: "atlas-2-006", label: "Atlas section 2 entry 006", value: 222 },
  { id: "atlas-2-007", label: "Atlas section 2 entry 007", value: 259 },
  { id: "atlas-2-008", label: "Atlas section 2 entry 008", value: 296 },
  { id: "atlas-2-009", label: "Atlas section 2 entry 009", value: 333 },
  { id: "atlas-2-010", label: "Atlas section 2 entry 010", value: 370 },
  { id: "atlas-2-011", label: "Atlas section 2 entry 011", value: 407 },
  { id: "atlas-2-012", label: "Atlas section 2 entry 012", value: 444 },
  { id: "atlas-2-013", label: "Atlas section 2 entry 013", value: 481 },
  { id: "atlas-2-014", label: "Atlas section 2 entry 014", value: 518 },
  { id: "atlas-2-015", label: "Atlas section 2 entry 015", value: 555 },
  { id: "atlas-2-016", label: "Atlas section 2 entry 016", value: 592 },
  { id: "atlas-2-017", label: "Atlas section 2 entry 017", value: 629 },
  { id: "atlas-2-018", label: "Atlas section 2 entry 018", value: 666 },
  { id: "atlas-2-019", label: "Atlas section 2 entry 019", value: 703 },
  { id: "atlas-2-020", label: "Atlas section 2 entry 020", value: 740 },
  { id: "atlas-2-021", label: "Atlas section 2 entry 021", value: 777 },
  { id: "atlas-2-022", label: "Atlas section 2 entry 022", value: 814 },
  { id: "atlas-2-023", label: "Atlas section 2 entry 023", value: 851 },
  { id: "atlas-2-024", label: "Atlas section 2 entry 024", value: 888 },
  { id: "atlas-2-025", label: "Atlas section 2 entry 025", value: 925 },
  { id: "atlas-2-026", label: "Atlas section 2 entry 026", value: 962 },
  { id: "atlas-2-027", label: "Atlas section 2 entry 027", value: 999 },
  { id: "atlas-2-028", label: "Atlas section 2 entry 028", value: 1036 },
  { id: "atlas-2-029", label: "Atlas section 2 entry 029", value: 1073 },
  { id: "atlas-2-030", label: "Atlas section 2 entry 030", value: 1110 },
  { id: "atlas-2-031", label: "Atlas section 2 entry 031", value: 1147 },
  { id: "atlas-2-032", label: "Atlas section 2 entry 032", value: 1184 },
  { id: "atlas-2-033", label: "Atlas section 2 entry 033", value: 1221 },
  { id: "atlas-2-034", label: "Atlas section 2 entry 034", value: 1258 },
  { id: "atlas-2-035", label: "Atlas section 2 entry 035", value: 1295 },
  { id: "atlas-2-036", label: "Atlas section 2 entry 036", value: 1332 },
  { id: "atlas-2-037", label: "Atlas section 2 entry 037", value: 1369 },
  { id: "atlas-2-038", label: "Atlas section 2 entry 038", value: 1406 },
  { id: "atlas-2-039", label: "Atlas section 2 entry 039", value: 1443 },
  { id: "atlas-2-040", label: "Atlas section 2 entry 040", value: 1480 },
  { id: "atlas-2-041", label: "Atlas section 2 entry 041", value: 1517 },
  { id: "atlas-2-042", label: "Atlas section 2 entry 042", value: 1554 },
  { id: "atlas-2-043", label: "Atlas section 2 entry 043", value: 1591 },
  { id: "atlas-2-044", label: "Atlas section 2 entry 044", value: 1628 },
  { id: "atlas-2-045", label: "Atlas section 2 entry 045", value: 1665 },
  { id: "atlas-2-046", label: "Atlas section 2 entry 046", value: 1702 },
  { id: "atlas-2-047", label: "Atlas section 2 entry 047", value: 1739 },
  { id: "atlas-2-048", label: "Atlas section 2 entry 048", value: 1776 },
  { id: "atlas-2-049", label: "Atlas section 2 entry 049", value: 1813 },
  { id: "atlas-2-050", label: "Atlas section 2 entry 050", value: 1850 },
  { id: "atlas-2-051", label: "Atlas section 2 entry 051", value: 1887 },
  { id: "atlas-2-052", label: "Atlas section 2 entry 052", value: 1924 },
  { id: "atlas-2-053", label: "Atlas section 2 entry 053", value: 1961 },
  { id: "atlas-2-054", label: "Atlas section 2 entry 054", value: 1998 },
  { id: "atlas-2-055", label: "Atlas section 2 entry 055", value: 2035 },
  { id: "atlas-2-056", label: "Atlas section 2 entry 056", value: 2072 },
  { id: "atlas-2-057", label: "Atlas section 2 entry 057", value: 2109 },
  { id: "atlas-2-058", label: "Atlas section 2 entry 058", value: 2146 },
  { id: "atlas-2-059", label: "Atlas section 2 entry 059", value: 2183 },
  { id: "atlas-2-060", label: "Atlas section 2 entry 060", value: 2220 },
];

// One of 6 sections of the atlas list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AtlasSection2() {
  return (
    <section className={styles.section} data-marker="marker-atlas-section-2">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
