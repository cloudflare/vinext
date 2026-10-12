import Link from "next/link";
import { connection } from "next/server";

export default async function SubBPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return (
    <>
      <h1 id="children-slot-loading-b">Sub b page</h1>
      <Link href="/children-slot-loading/sub/x/a" id="children-slot-loading-a-link">
        Sub a
      </Link>
    </>
  );
}
