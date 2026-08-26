export const revalidate = 60;

export default async function CacheProbeNoStorePage() {
  await fetch("data:text/plain,cache-probe", { cache: "no-store" });
  return <main>cache-probe no-store fetch</main>;
}
