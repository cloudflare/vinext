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

export async function getServerSideProps({ res }: { res: any }) {
  // Set a custom header
  res.setHeader("x-custom-header", "hello-from-gssp");
  // Set a cookie via Set-Cookie header
  res.setHeader("set-cookie", "gssp_token=abc123; Path=/; HttpOnly");
  // Set a non-default status code
  res.statusCode = 201;
  return {
    props: {
      greeting: "Headers were set",
    },
  };
}
