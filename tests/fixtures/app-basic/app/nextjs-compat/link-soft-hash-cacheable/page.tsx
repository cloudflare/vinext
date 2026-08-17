import Link from "next/link";

export const revalidate = 60;

export default function Page() {
  return (
    <>
      <Link
        href="/nextjs-compat/link-soft-hash-cacheable#section"
        replace
        prefetch={false}
        data-testid="soft-hash-cacheable-link"
      >
        Refresh section
      </Link>
      <div id="section">Section target</div>
    </>
  );
}
