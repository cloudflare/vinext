import { headers } from "next/headers";

export const revalidate = 3;

export function generateStaticParams() {
  return process.env.NEXT_PHASE === "phase-production-build" ? [{ slug: "known" }] : [];
}

export default async function PrerenderPhasePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
  if (!isProductionBuild) await headers();
  return (
    <p id="cacheability-result">
      phase={isProductionBuild ? "build" : "runtime"};{slug}
    </p>
  );
}
