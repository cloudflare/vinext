import Link from "next/link";

export default function Page() {
  return (
    <div>
      <Link href="/interception-dyn-single/groups/123" id="groups-link">
        Group 123
      </Link>
      <Link href="/interception-dyn-single/explicit-layout/deeper" id="nested-static-link">
        Nested static interception
      </Link>
    </div>
  );
}
