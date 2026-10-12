import { cookies } from "next/headers";

// next.config.ts gives this route a public CDN policy with `Vary: Cookie`, so
// each session must get its own render rather than another session's bytes.
export default async function CdnStageVaryCookiePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = (await cookies()).get("session")?.value ?? "anonymous";
  return (
    <main>{`vary-cookie-session:${session}; slug:${slug}; render-token:${crypto.randomUUID()}`}</main>
  );
}
