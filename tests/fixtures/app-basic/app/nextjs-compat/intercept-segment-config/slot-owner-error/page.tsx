import Link from "next/link";

export const dynamic = "error";

export default function Page() {
  return (
    <div>
      <p id="intercept-config-owner">slot-owner-error owner</p>
      <Link
        id="intercept-config-link"
        href="/nextjs-compat/intercept-segment-config/slot-owner-error/photo/1"
      >
        Open 1
      </Link>
    </div>
  );
}
