import Link from "next/link";

export default function Page() {
  return (
    <>
      <p id="blog">blog page</p>
      <Link href="/" id="to-index">
        to index
      </Link>
      <br />
    </>
  );
}
