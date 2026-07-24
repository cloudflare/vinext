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
      <Link href="/refreshing/other">Go to Other Page</Link>
    </div>
  );
}
