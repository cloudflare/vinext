import styles from "./atlas-section-1.module.css";

const ROWS = [
  { id: "atlas-1-001", label: "Atlas section 1 entry 001", value: 37 },
  { id: "atlas-1-002", label: "Atlas section 1 entry 002", value: 74 },
  { id: "atlas-1-003", label: "Atlas section 1 entry 003", value: 111 },
  { id: "atlas-1-004", label: "Atlas section 1 entry 004", value: 148 },
  { id: "atlas-1-005", label: "Atlas section 1 entry 005", value: 185 },
  { id: "atlas-1-006", label: "Atlas section 1 entry 006", value: 222 },
  { id: "atlas-1-007", label: "Atlas section 1 entry 007", value: 259 },
  { id: "atlas-1-008", label: "Atlas section 1 entry 008", value: 296 },
  { id: "atlas-1-009", label: "Atlas section 1 entry 009", value: 333 },
  { id: "atlas-1-010", label: "Atlas section 1 entry 010", value: 370 },
  { id: "atlas-1-011", label: "Atlas section 1 entry 011", value: 407 },
  { id: "atlas-1-012", label: "Atlas section 1 entry 012", value: 444 },
  { id: "atlas-1-013", label: "Atlas section 1 entry 013", value: 481 },
  { id: "atlas-1-014", label: "Atlas section 1 entry 014", value: 518 },
  { id: "atlas-1-015", label: "Atlas section 1 entry 015", value: 555 },
  { id: "atlas-1-016", label: "Atlas section 1 entry 016", value: 592 },
  { id: "atlas-1-017", label: "Atlas section 1 entry 017", value: 629 },
  { id: "atlas-1-018", label: "Atlas section 1 entry 018", value: 666 },
  { id: "atlas-1-019", label: "Atlas section 1 entry 019", value: 703 },
  { id: "atlas-1-020", label: "Atlas section 1 entry 020", value: 740 },
  { id: "atlas-1-021", label: "Atlas section 1 entry 021", value: 777 },
  { id: "atlas-1-022", label: "Atlas section 1 entry 022", value: 814 },
  { id: "atlas-1-023", label: "Atlas section 1 entry 023", value: 851 },
  { id: "atlas-1-024", label: "Atlas section 1 entry 024", value: 888 },
  { id: "atlas-1-025", label: "Atlas section 1 entry 025", value: 925 },
  { id: "atlas-1-026", label: "Atlas section 1 entry 026", value: 962 },
  { id: "atlas-1-027", label: "Atlas section 1 entry 027", value: 999 },
  { id: "atlas-1-028", label: "Atlas section 1 entry 028", value: 1036 },
  { id: "atlas-1-029", label: "Atlas section 1 entry 029", value: 1073 },
  { id: "atlas-1-030", label: "Atlas section 1 entry 030", value: 1110 },
  { id: "atlas-1-031", label: "Atlas section 1 entry 031", value: 1147 },
  { id: "atlas-1-032", label: "Atlas section 1 entry 032", value: 1184 },
  { id: "atlas-1-033", label: "Atlas section 1 entry 033", value: 1221 },
  { id: "atlas-1-034", label: "Atlas section 1 entry 034", value: 1258 },
  { id: "atlas-1-035", label: "Atlas section 1 entry 035", value: 1295 },
  { id: "atlas-1-036", label: "Atlas section 1 entry 036", value: 1332 },
  { id: "atlas-1-037", label: "Atlas section 1 entry 037", value: 1369 },
  { id: "atlas-1-038", label: "Atlas section 1 entry 038", value: 1406 },
  { id: "atlas-1-039", label: "Atlas section 1 entry 039", value: 1443 },
  { id: "atlas-1-040", label: "Atlas section 1 entry 040", value: 1480 },
  { id: "atlas-1-041", label: "Atlas section 1 entry 041", value: 1517 },
  { id: "atlas-1-042", label: "Atlas section 1 entry 042", value: 1554 },
  { id: "atlas-1-043", label: "Atlas section 1 entry 043", value: 1591 },
  { id: "atlas-1-044", label: "Atlas section 1 entry 044", value: 1628 },
  { id: "atlas-1-045", label: "Atlas section 1 entry 045", value: 1665 },
  { id: "atlas-1-046", label: "Atlas section 1 entry 046", value: 1702 },
  { id: "atlas-1-047", label: "Atlas section 1 entry 047", value: 1739 },
  { id: "atlas-1-048", label: "Atlas section 1 entry 048", value: 1776 },
  { id: "atlas-1-049", label: "Atlas section 1 entry 049", value: 1813 },
  { id: "atlas-1-050", label: "Atlas section 1 entry 050", value: 1850 },
  { id: "atlas-1-051", label: "Atlas section 1 entry 051", value: 1887 },
  { id: "atlas-1-052", label: "Atlas section 1 entry 052", value: 1924 },
  { id: "atlas-1-053", label: "Atlas section 1 entry 053", value: 1961 },
  { id: "atlas-1-054", label: "Atlas section 1 entry 054", value: 1998 },
  { id: "atlas-1-055", label: "Atlas section 1 entry 055", value: 2035 },
  { id: "atlas-1-056", label: "Atlas section 1 entry 056", value: 2072 },
  { id: "atlas-1-057", label: "Atlas section 1 entry 057", value: 2109 },
  { id: "atlas-1-058", label: "Atlas section 1 entry 058", value: 2146 },
  { id: "atlas-1-059", label: "Atlas section 1 entry 059", value: 2183 },
  { id: "atlas-1-060", label: "Atlas section 1 entry 060", value: 2220 },
];

// One of 6 sections of the atlas list. Each is about 5 kB and has a CSS
// module of its own; together they are over 20 kB.
export function AtlasSection1() {
  return (
    <section className={styles.section} data-marker="marker-atlas-section-1">
      {ROWS[0]!.label}
      <p>{ROWS.length}</p>
    </section>
  );
}
