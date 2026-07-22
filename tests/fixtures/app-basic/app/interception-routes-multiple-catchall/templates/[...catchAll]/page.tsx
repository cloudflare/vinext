import Link from "next/link";
const BASE = "/interception-routes-multiple-catchall";
export default async function Page({ params }: { params: Promise<{ catchAll: string[] }> }) {
  const { catchAll } = await params;
  return (
    <div>
      <div id="templates-catchall">templates/{catchAll.join("/")}</div>
      <Link href={`${BASE}/showcase/${catchAll.join("/")}`} id="to-showcase-catchall">
        to showcase/{catchAll.join("/")}
      </Link>
      <Link href={`${BASE}/showcase/single`} id="to-showcase-single">
        to showcase/single
      </Link>
      <Link href={`${BASE}/showcase/another/slug`} id="to-showcase-another">
        to showcase/another/slug
      </Link>
    </div>
  );
}
