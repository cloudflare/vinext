import Link from "next/link";
import { connection } from "next/server";

export default async function PlainOnePage() {
  await connection();

  return (
    <>
      <h1 id="ancestor-shared-layout-one">Plain one page</h1>
      <Link
        href="/ancestor-loading-shared-layout/plain/two"
        prefetch={false}
        id="ancestor-shared-layout-two-link"
      >
        Two
      </Link>
    </>
  );
}
