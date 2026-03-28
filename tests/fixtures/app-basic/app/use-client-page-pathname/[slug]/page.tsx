"use client";

import { usePathname, useSearchParams, useParams } from "next/navigation";

/**
 * Dynamic-segment variant of the "use client" page regression fixture.
 *
 * Exercises useParams() in addition to usePathname() / useSearchParams()
 * when the page component itself is a client component.
 */
export default function UseClientPagePathnameSlug() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams();

  return (
    <div id="client-page-dynamic-info">
      <span id="client-page-dynamic-pathname">{pathname}</span>
      <span id="client-page-dynamic-slug">{String(params.slug ?? "")}</span>
      <span id="client-page-dynamic-search">{searchParams.toString()}</span>
    </div>
  );
}
