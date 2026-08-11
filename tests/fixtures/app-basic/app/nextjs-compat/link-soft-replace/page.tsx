import Link from "next/link";

export const revalidate = 0;

export default function Page() {
  return (
    <>
      <h1 data-testid="soft-replace-render-id">{crypto.randomUUID()}</h1>
      <Link
        href="/nextjs-compat/link-soft-replace"
        replace
        prefetch={false}
        data-testid="soft-replace-link"
      >
        Refresh
      </Link>
      <Link
        href="/nextjs-compat/link-soft-replace?q=%20"
        replace
        prefetch={false}
        data-testid="soft-replace-encoded-link"
      >
        Encoded query
      </Link>
      <Link
        href="/nextjs-compat/link-soft-replace#section"
        replace
        prefetch={false}
        data-testid="soft-replace-section-link"
      >
        Section
      </Link>
      <Link
        href="/nextjs-compat/link-soft-replace#other"
        replace
        prefetch={false}
        data-testid="soft-replace-other-link"
      >
        Other
      </Link>
      <div id="section">Section target</div>
      <div id="other">Other target</div>
    </>
  );
}
