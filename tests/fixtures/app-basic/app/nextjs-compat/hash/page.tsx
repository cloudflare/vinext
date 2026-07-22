import Link from "next/link";
import "./global.css";

export default function HashPage() {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: i }));

  return (
    <div style={{ fontFamily: "sans-serif", fontSize: "16px" }}>
      <p>Hash Page</p>
      <Link href="/nextjs-compat/hash#hash-6" id="link-to-6">
        To 6
      </Link>
      <Link href="/nextjs-compat/hash#hash-50" id="link-to-50">
        To 50
      </Link>
      <Link href="/nextjs-compat/hash#hash-160" id="link-to-160">
        To 160
      </Link>
      <Link href="/nextjs-compat/hash#hash-300" id="link-to-300">
        To 300
      </Link>
      <Link href="#hash-500" id="link-to-500">
        To 500 (hash only)
      </Link>
      <Link href="/nextjs-compat/hash#top" id="link-to-top">
        To Top
      </Link>
      <Link href="/nextjs-compat/hash#non-existent" id="link-to-non-existent">
        To non-existent
      </Link>
      <div>
        <Link href="?with-query-param#hash-160" id="link-to-query-param">
          To 160 (with query param)
        </Link>
      </div>
      <div>
        {items.map((item) => (
          <div key={item.id}>
            <div id={`hash-${item.id}`}>{item.id}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
