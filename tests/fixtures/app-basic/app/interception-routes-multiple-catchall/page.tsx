import Link from "next/link";
const BASE = "/interception-routes-multiple-catchall";
export default function Page() {
  return (
    <div>
      <Link href={`${BASE}/templates/multi/slug`} id="to-templates-multi">
        To templates/multi/slug
      </Link>
    </div>
  );
}
