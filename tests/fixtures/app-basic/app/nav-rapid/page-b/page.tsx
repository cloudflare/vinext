import Link from "next/link";

export default function PageB() {
  return (
    <div>
      <h1>Page B</h1>
      <nav>
        <Link href="/nav-rapid/page-a">Go to A</Link>
        {" | "}
        <Link href="/nav-rapid/page-c">Go to C</Link>
      </nav>
    </div>
  );
}
