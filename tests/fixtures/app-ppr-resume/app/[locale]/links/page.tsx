import Link from "next/link";

// Links to pages under the root param, a generated and an unknown value.
export default function LinksPage() {
  return (
    <main>
      <Link id="link-en-about" href="/en/about">
        en about
      </Link>
      <Link id="link-fr-about" href="/fr/about">
        fr about
      </Link>
    </main>
  );
}
