interface Props {
  greeting: string;
}

export default function SSRHeadersPage({ greeting }: Props) {
  return (
    <div>
      <h1>SSR Headers Test</h1>
      <p data-testid="greeting">{greeting}</p>
    </div>
  );
}

export async function getServerSideProps({ res, query }: { res: any; query: { status?: string } }) {
  // Set a custom header
  res.setHeader("x-custom-header", "hello-from-gssp");
  // Set multiple cookies, including an Expires value whose comma must not be
  // mistaken for a cookie separator.
  res.setHeader("set-cookie", [
    "gssp_token=abc123; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; HttpOnly",
    "gssp_notice=reauthenticate; Path=/",
  ]);
  // Set a non-default status code
  res.statusCode = query.status ? Number(query.status) : 201;
  if (res.statusCode === 205) res.setHeader("content-length", "32");
  return {
    props: {
      greeting: "Headers were set",
    },
  };
}
