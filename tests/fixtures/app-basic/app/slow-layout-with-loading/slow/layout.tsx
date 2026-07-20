async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function SlowLayout({ children }: { children: React.ReactNode }) {
  await delay(3000);

  return (
    <section>
      <p id="slow-layout-message">Slow layout resolved</p>
      {children}
    </section>
  );
}
