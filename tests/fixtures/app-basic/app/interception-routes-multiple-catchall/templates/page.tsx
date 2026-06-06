import Link from "next/link";
const BASE = "/interception-routes-multiple-catchall";
export default function Page() {
  return (
    <div>
      <div id="templates-page">templates page</div>
      <Link href={`${BASE}/showcase/new`} id="to-showcase-new">
        to showcase/new
      </Link>
    </div>
  );
}
