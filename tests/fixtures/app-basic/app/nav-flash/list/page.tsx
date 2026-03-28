import Link from "next/link";

export default function ListPage() {
  return (
    <div>
      <h1 id="list-title">Nav Flash List</h1>
      <ul id="nav-list">
        <li>
          <Link href="/nav-flash/link-sync" id="back-to-sync">
            Back to Link Sync
          </Link>
        </li>
        <li>
          <Link href="/nav-flash/query-sync" id="to-query-sync">
            Query Sync
          </Link>
        </li>
        <li>
          <Link href="/nav-flash/param-sync/active" id="to-param-sync">
            Param Sync
          </Link>
        </li>
      </ul>
    </div>
  );
}
