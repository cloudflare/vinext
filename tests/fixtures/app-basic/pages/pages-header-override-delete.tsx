type Props = {
  authorization: string | null;
  cookie: string | null;
  middlewareHeader: string | null;
};

export async function getServerSideProps({
  req,
}: {
  req: { headers: Record<string, string | undefined> };
}) {
  return {
    props: {
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      middlewareHeader: req.headers["x-from-middleware"] ?? null,
    } satisfies Props,
  };
}

export default function PagesHeaderOverrideDeletePage({
  authorization,
  cookie,
  middlewareHeader,
}: Props) {
  return (
    <main>
      <h1>Pages Header Override Delete</h1>
      <p id="authorization">{authorization}</p>
      <p id="cookie">{cookie}</p>
      <p id="middleware-header">{middlewareHeader}</p>
    </main>
  );
}
