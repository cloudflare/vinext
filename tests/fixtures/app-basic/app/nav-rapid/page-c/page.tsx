import Link from "next/link";

export default function PageC() {
  return (
    <div>
      <h1>Page C</h1>
      <nav>
        <Link href="/nav-rapid/page-a">Go to A</Link>
        {" | "}
        <Link href="/nav-rapid/page-b">Go to B</Link>
      </nav>
    </div>
  );
}
