import Link from "next/link";
import { Counter } from "./counter";

export default async function SectionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;

  return (
    <div>
      <h2>Section {section}</h2>
      <Counter id={`section-${section}`} label="Section counter" />
      <nav>
        <ul>
          <li>
            <Link href={`/nextjs-compat/back-forward-cache/nested/a/item/1`}>
              Item 1 (section a)
            </Link>
          </li>
          <li>
            <Link href={`/nextjs-compat/back-forward-cache/nested/a/item/2`}>
              Item 2 (section a)
            </Link>
          </li>
          <li>
            <Link href={`/nextjs-compat/back-forward-cache/nested/b/item/1`}>
              Item 1 (section b)
            </Link>
          </li>
          <li>
            <Link href={`/nextjs-compat/back-forward-cache/nested/b/item/2`}>
              Item 2 (section b)
            </Link>
          </li>
        </ul>
      </nav>
      <div>{children}</div>
    </div>
  );
}
