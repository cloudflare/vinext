import Link from "next/link";

export default function NavTest() {
  return (
    <>
      <h1>Navigation Test</h1>
      <p>Filesystem route wins before afterFiles.</p>
      <Link href="/">Home</Link>
    </>
  );
}
