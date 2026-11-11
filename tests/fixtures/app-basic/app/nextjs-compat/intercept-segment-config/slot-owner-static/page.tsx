import Link from "next/link";

export const dynamic = "force-static";

export default function Page() {
  return (
    <div>
      <p id="intercept-config-owner">slot-owner-static owner</p>
      <Link
        id="intercept-config-link"
        href="/nextjs-compat/intercept-segment-config/slot-owner-static/photo/1"
      >
        Open 1
      </Link>
    </div>
  );
}
