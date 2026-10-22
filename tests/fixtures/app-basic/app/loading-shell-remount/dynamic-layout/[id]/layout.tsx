import type { ReactNode } from "react";
import { sleep } from "../../sleep";

// Rendered with its URL's params above loading.tsx, so a shell carries it.
export default async function IdLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await sleep(800);
  return (
    <section>
      <p id="layout-id">{id}</p>
      {children}
    </section>
  );
}
