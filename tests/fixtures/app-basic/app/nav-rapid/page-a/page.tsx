import Link from "next/link";

export default function PageA() {
  return (
    <div>
      <h1>Page A</h1>
      <nav>
        <Link href="/nav-rapid/page-b">Go to B</Link>
        {" | "}
        <Link href="/nav-rapid/page-b?filter=test">Go to B with Filter</Link>
        {" | "}
        <Link href="/nav-rapid/page-c">Go to C</Link>
      </nav>
    </div>
  );
}
