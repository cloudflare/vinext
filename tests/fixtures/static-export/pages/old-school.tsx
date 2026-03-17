import Link from "next/link";

export default function OldSchool() {
  return (
    <main>
      <h1>Old-school Page (Pages Router)</h1>
      <p>A static Pages Router page rendered with getStaticProps.</p>
      <Link href="/">Back to home (App Router)</Link>
    </main>
  );
}

export async function getStaticProps() {
  return { props: {} };
}
