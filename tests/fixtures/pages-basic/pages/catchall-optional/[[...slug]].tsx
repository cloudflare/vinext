import Link from "next/link";

export default function OptionalCatchAll({ slug }: { slug: string[] }) {
  return (
    <main>
      <p id="catchall">Catch all: [{slug.join(", ")}]</p>
      <Link href="/" id="home">
        Go home
      </Link>
    </main>
  );
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { slug: [] } }, { params: { slug: ["value"] } }],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { slug?: string[] } }) {
  return {
    props: {
      slug: params.slug ?? [],
    },
  };
}
