import Link from "next/link";
import { connection } from "next/server";

export default async function SubAPage() {
  await connection();

  return (
    <>
      <h1 id="children-slot-default-loading-a">Sub a page</h1>
      <Link href="/children-slot-default-loading/sub/b" id="children-slot-default-loading-b-link">
        Sub b
      </Link>
    </>
  );
}
