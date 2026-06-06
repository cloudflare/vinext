import Link from "next/link";
const BASE = "/interception-segments-two-levels-above";
export default function Page() {
  return (
    <div>
      <Link href={`${BASE}/foo/bar`} id="go-foo-bar">
        Go to foo/bar
      </Link>
    </div>
  );
}
