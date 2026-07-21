export async function generateMetadata(props: Record<string, unknown>) {
  const searchParams = await (props.searchParams as Promise<{ source?: string }> | undefined);
  return {
    title: `Streamed not-found search=${"searchParams" in props} source=${searchParams?.source ?? "missing"}`,
  };
}

export default function MetadataStreamingNotFoundSearchParams() {
  return <main>Streamed metadata not found without search params</main>;
}
