import Link from "next/link";
import { connection } from "next/server";

export default async function PlainThreePage() {
  await connection();

  return (
    <>
      <h1 id="ancestor-shared-layout-three">Plain three page</h1>
      <Link
        href="/ancestor-loading-shared-layout/plain/four"
        prefetch={false}
        id="ancestor-shared-layout-four-link"
      >
        Four
      </Link>
    </>
  );
}
