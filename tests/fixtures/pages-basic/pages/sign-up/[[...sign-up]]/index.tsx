export default function SignUpPage({ segments }: { segments: string[] }) {
  return (
    <main data-testid="sign-up-page">
      <h1>Sign Up</h1>
      <p data-testid="sign-up-segments">Segments: {segments.length}</p>
      <p data-testid="sign-up-path">Path: {segments.length > 0 ? segments.join("/") : "(root)"}</p>
    </main>
  );
}

export async function getServerSideProps({
  params,
}: {
  params: { "sign-up"?: string[] };
}) {
  return {
    props: {
      segments: params["sign-up"] ?? [],
    },
  };
}
