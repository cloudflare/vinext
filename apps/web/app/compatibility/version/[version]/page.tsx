/**
 * The unlisted /compatibility dashboard for any stored Next.js version.
 * Reached through `/compatibility?version=<ref>` (rewritten in
 * next.config.ts), so results for versions that aren't public yet can be
 * checked without surfacing them on /compatibility.
 *
 * The version comes from the route params, never from `searchParams`, so
 * each version is cached like the public page.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isValidNextRef } from "@/app/lib/compat-version";
import { CompatibilityDashboard } from "../../compatibility-dashboard";

// Same ISR window as the public /compatibility page.
export const revalidate = 300;

// Versions render on first request, then follow the ISR window above.
export function generateStaticParams(): { version: string }[] {
  return [];
}

export const metadata: Metadata = {
  title: "Next.js compatibility — vinext",
  alternates: {
    canonical: "/compatibility",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default async function CompatibilityVersionPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  if (!isValidNextRef(version)) notFound();
  return <CompatibilityDashboard nextRef={version} />;
}
