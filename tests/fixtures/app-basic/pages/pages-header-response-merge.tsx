type Props = {
  viewerRole: string | null;
  empty: string | null;
};

export async function getServerSideProps({
  req,
}: {
  req: { headers: Record<string, string | string[] | undefined> };
}) {
  return {
    props: {
      viewerRole: (req.headers["x-viewer-role"] as string | undefined) ?? null,
      empty: (req.headers["x-empty-from-middleware"] as string | undefined) ?? null,
    } satisfies Props,
  };
}

export default function PagesHeaderResponseMergePage({ viewerRole, empty }: Props) {
  return (
    <main>
      <h1>Pages Header Response Merge</h1>
      <p id="viewer-role">{viewerRole}</p>
      <p id="empty">{empty}</p>
    </main>
  );
}
