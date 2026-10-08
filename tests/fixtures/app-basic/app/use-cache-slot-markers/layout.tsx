"use cache";

import type { ReactNode } from "react";

export default async function Layout({
  children,
  $$isPage,
}: {
  children: ReactNode;
  $$isPage: ReactNode;
}) {
  return (
    <section>
      {$$isPage}
      {children}
    </section>
  );
}
