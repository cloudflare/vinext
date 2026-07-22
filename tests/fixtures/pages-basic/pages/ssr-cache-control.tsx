interface Props {
  message: string;
}

// Regression fixture for #1461: a getServerSideProps page that overrides
// Cache-Control via res.setHeader. The override must be forwarded to the
// final HTTP response instead of being replaced by the gssp default.
export default function SSRCacheControlPage({ message }: Props) {
  return (
    <div>
      <h1>SSR Cache-Control Override</h1>
      <p data-testid="message">{message}</p>
    </div>
  );
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function getServerSideProps({ res }: { res: any }) {
  res.setHeader("Cache-Control", "public, max-age=42");
  return {
    props: {
      message: "Cache-Control override applied",
    },
  };
}
