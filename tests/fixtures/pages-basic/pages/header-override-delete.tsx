interface Props {
  authorization: string | null;
  cookie: string | null;
  middlewareHeader: string | null;
}

export default function HeaderOverrideDeletePage({
  authorization,
  cookie,
  middlewareHeader,
}: Props) {
  return (
    <div>
      <p id="authorization">{authorization ?? "null"}</p>
      <p id="cookie">{cookie ?? "null"}</p>
      <p id="middleware-header">{middlewareHeader ?? "null"}</p>
    </div>
  );
}

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
    },
  };
}
