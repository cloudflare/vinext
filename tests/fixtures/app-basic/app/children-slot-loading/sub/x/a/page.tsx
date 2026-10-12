import Link from "next/link";
import { connection } from "next/server";

export default async function SubAPage() {
  await connection();

  return (
    <>
      <h1 id="children-slot-loading-a">Sub a page</h1>
      <Link href="/children-slot-loading/sub/x/b" id="children-slot-loading-b-link">
        Sub b
      </Link>
    </>
  );
}
