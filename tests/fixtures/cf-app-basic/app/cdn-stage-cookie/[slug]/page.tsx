import { cookies } from "next/headers";

export default async function CdnStageCookiePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cookie = (await cookies()).get("stage-cookie")?.value ?? "missing";
  return <main>{`middleware-cookie:${cookie}; slug:${slug}`}</main>;
}
