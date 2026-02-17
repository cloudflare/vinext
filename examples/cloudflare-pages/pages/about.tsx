import Link from "next/link";

export default function About() {
  return (
    <>
      <h1>About</h1>
      <p>This is the about page running on Cloudflare Workers.</p>
      <Link href="/">Home</Link>
    </>
  );
}
