export const dynamic = "force-dynamic";

export default async function ForceDynamicPage({ params }: { params: Promise<{ mode: string }> }) {
  const { mode } = await params;
  return <h1>Force dynamic {mode}</h1>;
}
