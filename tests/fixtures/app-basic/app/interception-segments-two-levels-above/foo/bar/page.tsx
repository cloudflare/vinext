import Link from "next/link";
const BASE = "/interception-segments-two-levels-above";
export default function Page() {
  return (
    <div>
      <div id="foo-bar-page">foo/bar page</div>
      <Link href={`${BASE}/hoge`} id="link-hoge">
        to hoge
      </Link>
    </div>
  );
}
