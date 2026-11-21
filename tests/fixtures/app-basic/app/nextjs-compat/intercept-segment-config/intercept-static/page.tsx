import Link from "next/link";

export default function Page() {
  return (
    <div>
      <p id="intercept-config-owner">intercept-static owner</p>
      <Link
        id="intercept-config-link"
        href="/nextjs-compat/intercept-segment-config/intercept-static/1"
      >
        Open 1
      </Link>
    </div>
  );
}
