import Link from "next/link";

export default function Page() {
  return (
    <>
      <p id="index">index page</p>
      <Link href="/skip-trailing-slash/another" id="to-another">
        to another
      </Link>
      <br />
      <Link href="/skip-trailing-slash/another/" id="to-another-with-slash">
        to another
      </Link>
      <br />
      <Link href="/skip-trailing-slash/blog/first" id="to-blog-first">
        to /blog/first
      </Link>
      <br />
    </>
  );
}
