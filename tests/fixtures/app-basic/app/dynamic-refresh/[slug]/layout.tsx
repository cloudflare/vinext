import Link from "next/link";

export const dynamic = "force-dynamic";

export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div>
      {children}
      {modal}
      <Link href="/dynamic-refresh/foo/other">Go to Dynamic Other Page</Link>
    </div>
  );
}
