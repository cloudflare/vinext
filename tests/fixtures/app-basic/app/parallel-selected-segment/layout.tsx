"use client";

import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";

export default function Layout({
  children,
  auth,
  nav,
}: {
  children: React.ReactNode;
  auth: React.ReactNode;
  nav: React.ReactNode;
}) {
  const authSegment = useSelectedLayoutSegment("auth");
  const navSegment = useSelectedLayoutSegment("nav");
  const routeSegment = useSelectedLayoutSegment();
  const router = useRouter();

  return (
    <section>
      <nav>
        <Link href="/parallel-selected-segment">Main</Link>
        <Link href="/parallel-selected-segment/foo">Foo</Link>
        <button id="replace-foo" onClick={() => router.replace("/parallel-selected-segment/foo")}>
          Replace Foo
        </button>
        <Link href="/parallel-selected-segment/login">Login</Link>
        <Link href="/parallel-selected-segment/reset">Reset</Link>
        <Link href="/parallel-selected-segment/reset/withEmail">Reset with Email</Link>
        <Link href="/parallel-selected-segment/reset/withMobile">Reset with Mobile</Link>
      </nav>
      <div id="navSegment">navSegment (parallel route): {navSegment}</div>
      <div id="authSegment">authSegment (parallel route): {authSegment}</div>
      <div id="routeSegment">routeSegment (app route): {routeSegment}</div>
      <section id="navSlot">{nav}</section>
      <section id="authSlot">{auth}</section>
      <section id="children">{children}</section>
    </section>
  );
}
