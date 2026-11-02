type Props = {
  revalidateType: string;
  revalidateError: string | null;
};

// Next.js only attaches `res.revalidate()` to API route responses
// (packages/next/src/server/api-utils/node/api-resolver.ts). A page's
// getServerSideProps receives a plain ServerResponse without it.
export async function getServerSideProps({ res }: { res: { revalidate?: unknown } }) {
  const revalidate = res.revalidate;
  let revalidateError: string | null = null;
  if (typeof revalidate === "function") {
    try {
      await revalidate.call(res, "/");
    } catch (error) {
      revalidateError = String(error);
    }
  }
  return {
    props: { revalidateType: typeof revalidate, revalidateError } satisfies Props,
  };
}

export default function GsspResRevalidatePage({ revalidateType, revalidateError }: Props) {
  return (
    <main>
      <p id="revalidate-type">res.revalidate: {revalidateType}</p>
      <p id="revalidate-error">{revalidateError}</p>
    </main>
  );
}
