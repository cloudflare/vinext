import Link from "next/link";

export default function ClubDefault() {
  return (
    <div>
      <p id="intercept-grouped-children-default">Club default</p>
      <Link href="/nextjs-compat/intercept-source-group-grouped-children/club/members">
        Club members
      </Link>
    </div>
  );
}
