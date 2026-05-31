// Regression fixture for issue #1466: ensure `useParams()` from
// `next/navigation` works on a Pages Router page when the fixture ALSO has
// an App Router (`app/` directory).
//
// Ported from Next.js:
// .nextjs-ref/test/e2e/app-dir/use-params/pages/pages-dir/[dynamic]/index.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/pages/pages-dir/[dynamic]/index.tsx
import { useParams } from "next/navigation";

export default function Page() {
  const params = useParams();
  return (
    <div>
      <div id="params">{JSON.stringify(params?.dynamic)}</div>
    </div>
  );
}
