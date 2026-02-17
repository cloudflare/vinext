/**
 * Next.js compat: not-found/basic — dynamic page that triggers notFound() for specific param
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/error-boundary/nested/[dynamic]/page.js
 */
import { notFound } from "next/navigation";

export default async function Page(props: { params: Promise<{ dynamic: string }> }) {
  const params = await props.params;
  if (params.dynamic === "trigger-not-found") {
    notFound();
  }

  return <div>Hello World</div>;
}
