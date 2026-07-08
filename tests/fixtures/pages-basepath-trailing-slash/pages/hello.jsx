// Ported from vercel/next.js test/e2e/basepath/pages/hello.js
// (only the #something-else-link Link the trailing-slash replace-state test
// uses; href !== as is the core repro).
import Link from "next/link";

export default function Hello() {
  return (
    <>
      <h1 id="hello-page">hello page</h1>
      <Link href="/something-else" as="/hello" id="something-else-link">
        to something else
      </Link>
    </>
  );
}
