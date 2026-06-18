import Link from "next/link";

export default function Page() {
  return (
    <>
      <Link href="/nextjs-compat/javascript-urls/rsc-redirect" id="rsc-redirect-link">
        trigger rsc redirect
      </Link>
      <Link href="/nextjs-compat/javascript-urls/safe">safe link</Link>
    </>
  );
}
