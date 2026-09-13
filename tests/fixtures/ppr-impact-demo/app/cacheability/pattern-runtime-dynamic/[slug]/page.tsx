import { headers } from "next/headers";

export const revalidate = 60;

export function generateStaticParams() {
  return [{ slug: "static" }, { slug: "dynamic" }];
}

export default async function PatternRuntimeDynamicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug === "dynamic") await headers();
  return <main>pattern runtime {slug}</main>;
}
