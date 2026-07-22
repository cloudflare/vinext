import Link from "next/link";

export default function PageA() {
  return (
    <div>
      <h1>Page A</h1>
      <nav>
        <Link href="/nav-rapid/page-b" prefetch={false} data-testid="page-a-link-to-b">
          Go to B
        </Link>
        {" | "}
        <Link
          href="/nav-rapid/page-b?filter=test"
          prefetch={false}
          data-testid="page-a-link-to-b-filter"
        >
          Go to B with Filter
        </Link>
        {" | "}
        <Link href="/nav-rapid/page-c" prefetch={false} data-testid="page-a-link-to-c">
          Go to C
        </Link>
      </nav>
    </div>
  );
}
