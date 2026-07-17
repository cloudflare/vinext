async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function SlowLayout({ children }: { children: React.ReactNode }) {
  await delay(750);

  return (
    <section>
      <p id="slow-combined-layout-message">Slow layout resolved</p>
      {children}
    </section>
  );
}
