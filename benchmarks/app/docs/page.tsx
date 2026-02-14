import Link from "next/link";
export const metadata = { title: "Documentation" };
const sections = ["getting-started", "installation", "configuration", "api-reference", "deployment", "troubleshooting", "migration", "plugins"];
export default function DocsIndex() {
  return (<div><h1>Documentation</h1><ul>{sections.map(s => <li key={s}><Link href={`/docs/${s}`}>{s.replace(/-/g, " ")}</Link></li>)}</ul></div>);
}

