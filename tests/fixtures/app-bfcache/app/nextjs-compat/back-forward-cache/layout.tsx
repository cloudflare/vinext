import Link from "next/link";

const base = "/nextjs-compat/back-forward-cache/page";

export default function BackForwardCacheLayout({ children }: { children: React.ReactNode }) {
  const links = [];
  for (let n = 1; n <= 5; n++) {
    links.push(
      <li key={n}>
        <Link href={`${base}/${n}`}>Page {n}</Link>
      </li>,
    );
    links.push(
      <li key={`${n}-with-search-param`}>
        <Link href={`${base}/${n}?param=true`}>Page {n} (with search param)</Link>
      </li>,
    );
  }

  return (
    <>
      <ul>{links}</ul>
      <div>{children}</div>
    </>
  );
}
