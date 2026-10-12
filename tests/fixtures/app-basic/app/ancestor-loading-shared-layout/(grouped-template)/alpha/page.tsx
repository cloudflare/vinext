import Link from "next/link";
import { connection } from "next/server";

export default async function AlphaPage() {
  await connection();

  return (
    <>
      <h1 id="ancestor-shared-layout-alpha">Alpha page</h1>
      <Link
        href="/ancestor-loading-shared-layout/beta"
        prefetch={false}
        id="ancestor-shared-layout-beta-link"
      >
        Beta
      </Link>
    </>
  );
}
