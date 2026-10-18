type Props = {
  authorization: string | null;
  cookie: string | null;
  middlewareHeader: string | null;
  forwardedMiddlewareContextVisible: boolean;
};

export async function getServerSideProps({
  req,
}: {
  req: { headers: Record<string, string | undefined>; rawHeaders?: string[] };
}) {
  return {
    props: {
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      middlewareHeader: req.headers["x-from-middleware"] ?? null,
      // vinext's internal hybrid dev header must never reach Pages handlers.
      forwardedMiddlewareContextVisible:
        "x-vinext-mw-ctx" in req.headers ||
        (req.rawHeaders?.some((name) => name.toLowerCase() === "x-vinext-mw-ctx") ?? false),
    } satisfies Props,
  };
}

export default function PagesHeaderOverrideDeletePage({
  authorization,
  cookie,
  middlewareHeader,
  forwardedMiddlewareContextVisible,
}: Props) {
  return (
    <main>
      <h1>Pages Header Override Delete</h1>
      <p id="authorization">{authorization}</p>
      <p id="cookie">{cookie}</p>
      <p id="middleware-header">{middlewareHeader}</p>
      <p id="forwarded-mw-ctx-visible">{String(forwardedMiddlewareContextVisible)}</p>
    </main>
  );
}
