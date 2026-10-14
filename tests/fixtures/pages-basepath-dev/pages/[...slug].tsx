import Link from "next/link";
import { useRouter } from "next/router";

type Props = { slug: string[] };

// A root catch-all: an empty first segment interpolates to `//...`, which
// Next.js keeps on the app origin behind the basePath.
export default function CatchAll({ slug }: Props) {
  const router = useRouter();
  return (
    <>
      <pre id="catch-all-state">
        {JSON.stringify({ slug, query: router.query, asPath: router.asPath })}
      </pre>
      <Link
        id="empty-segment-link"
        href={{ pathname: "/[...slug]", query: { slug: ["", "attacker.example", "x"] } }}
      >
        Empty first segment
      </Link>
    </>
  );
}

export function getServerSideProps({ params }: { params: { slug: string[] } }) {
  return { props: { slug: params.slug } };
}
