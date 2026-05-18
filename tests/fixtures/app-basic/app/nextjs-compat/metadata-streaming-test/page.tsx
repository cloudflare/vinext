// Ported from Next.js: test/e2e/app-dir/metadata-streaming/app/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/app/page.tsx
export default function Page() {
  return <p>index page</p>;
}

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    title: "metadata streaming index page",
  };
}

export const dynamic = "force-dynamic";
