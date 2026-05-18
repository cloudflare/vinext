// Ported from Next.js: test/e2e/app-dir/metadata-streaming/app/slow/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/app/slow/page.tsx
export default function Page() {
  return <p>slow</p>;
}

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    title: "slow streaming page",
    description: "slow page description",
    generator: "vinext",
    applicationName: "test",
    referrer: "origin-when-cross-origin",
    keywords: ["next.js", "react", "javascript"],
    authors: [{ name: "huozhi" }],
    creator: "huozhi",
    publisher: "vercel",
    robots: "index, follow",
  };
}

export const dynamic = "force-dynamic";
