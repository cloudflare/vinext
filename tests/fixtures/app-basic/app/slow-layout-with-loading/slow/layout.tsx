import type { ReactNode } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return "Slow layout loaded";
}

export default async function SlowLayout({ children }: { children: ReactNode }) {
  const message = await getData();

  return (
    <section>
      <p id="slow-layout-message">{message}</p>
      {children}
    </section>
  );
}
