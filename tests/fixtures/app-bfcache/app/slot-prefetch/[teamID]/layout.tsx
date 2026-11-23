import Link from "next/link";

// Ported from Next.js:
// test/e2e/app-dir/parallel-route-navigations/app/[teamID]/layout.tsx
export default function Layout(props: { slot: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <ul>
        <li>
          <Link href="/slot-prefetch/vercel/sub/folder">/slot-prefetch/vercel/sub/folder</Link>
        </li>
        <li>
          <Link href="/slot-prefetch/vercel/sub/other-folder">
            /slot-prefetch/vercel/sub/other-folder
          </Link>
        </li>
      </ul>
      <div data-slot>{props.slot}</div>
      <div data-children>{props.children}</div>
    </div>
  );
}
