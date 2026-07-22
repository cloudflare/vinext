import Link from "next/link";

export default function Layout(props: { slot: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <ul>
        <li>
          <Link href="/parallel-route-navigations/vercel/sub/folder">
            /parallel-route-navigations/vercel/sub/folder
          </Link>
        </li>
        <li>
          <Link href="/parallel-route-navigations/vercel/sub/other-folder">
            /parallel-route-navigations/vercel/sub/other-folder
          </Link>
        </li>
      </ul>
      <div data-slot>{props.slot}</div>
      <div data-children>{props.children}</div>
    </div>
  );
}
