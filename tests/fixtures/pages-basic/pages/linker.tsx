import Link from "next/link";

// Regression fixture for issue #1471: when `?href=/path?query=value` is passed
// through the URL, the Pages Router must preserve the embedded `?query=value`
// portion when rendering `<Link href={...}>` and when calling `router.push()`.
// Ported from Next.js: test/e2e/trailing-slashes/pages/linker.js
//
// `getServerSideProps` receives the parsed `query.href` value, which by RFC
// 3986 contains everything after the first `?`. The rendered `<Link>` must
// then output an `<a href>` that matches the original target verbatim.

interface LinkerProps {
  href: string;
}

export default function Linker({ href }: LinkerProps) {
  return (
    <div>
      <Link href={href} id="link">
        link to {href}
      </Link>
    </div>
  );
}

export async function getServerSideProps(context: {
  query: Record<string, string | string[] | undefined>;
}) {
  const raw = context.query.href;
  const href = typeof raw === "string" ? raw : "/";
  return { props: { href } };
}
