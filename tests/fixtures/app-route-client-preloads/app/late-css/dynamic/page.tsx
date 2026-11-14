import nextDynamic from "next/dynamic";

export const dynamic = "force-dynamic";

const Widget = nextDynamic(() => import("./widget"));

export default async function LateDynamicPage() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <Widget />;
}
