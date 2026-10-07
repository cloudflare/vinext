// Makes the generateMetadata() of
// /nextjs-compat/isr-special-error/metadata-not-found-regen call notFound().
export const dynamic = "force-dynamic";

export function GET() {
  (globalThis as { __vinextMetadataNotFoundRegen?: boolean }).__vinextMetadataNotFoundRegen = true;
  return new Response("ok");
}
