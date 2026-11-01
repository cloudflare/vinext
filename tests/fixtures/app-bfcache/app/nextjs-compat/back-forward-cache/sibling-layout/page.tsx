import Link from "next/link";
import { Counter } from "../nested/[section]/counter";

export default function SiblingLayoutPage() {
  return (
    <div>
      <h3>Sibling layout parent</h3>
      <Counter id="sibling-parent" label="Parent counter" />
      <Link href="/nextjs-compat/back-forward-cache/sibling-layout/child">Child with layout</Link>
    </div>
  );
}
