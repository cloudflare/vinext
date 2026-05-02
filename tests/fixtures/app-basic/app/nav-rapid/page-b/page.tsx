import Link from "next/link";

export default function PageB() {
  return (
    <div>
      <h1>Page B</h1>
      <nav>
        <Link href="/nav-rapid/page-a" prefetch={false} data-testid="link-to-a">
          Go to A
        </Link>
        {" | "}
        <Link href="/nav-rapid/page-c" prefetch={false} data-testid="link-to-c">
          Go to C
        </Link>
        {" | "}
        <Link href="/nav-rapid/page-b?filter=test" prefetch={false} data-testid="link-add-filter">
          Add Filter
        </Link>
      </nav>
    </div>
  );
}
