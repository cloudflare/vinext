import Link from "next/link";
import { SearchInfo } from "./search-info";

export default function Home() {
  return (
    <>
      <h1 id="home">Home</h1>
      <SearchInfo />
      <Link
        id="link-to-dummy-1"
        href="/nextjs-compat/stale-search-params-on-replace-regression/dummy-page-1"
      >
        Go to dummy page 1
      </Link>
    </>
  );
}
