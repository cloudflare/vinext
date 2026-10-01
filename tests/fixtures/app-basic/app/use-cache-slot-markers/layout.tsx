"use cache";

import type { ReactNode } from "react";

export default async function Layout({
  children,
  $$isLayout,
  $$isPage,
}: {
  children: ReactNode;
  $$isLayout: ReactNode;
  $$isPage: ReactNode;
}) {
  return (
    <section>
      {$$isLayout}
      {$$isPage}
      {children}
    </section>
  );
}
