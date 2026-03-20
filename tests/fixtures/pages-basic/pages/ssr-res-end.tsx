export default function SSRResEndPage() {
  return (
    <div>
      <h1>This should never render</h1>
    </div>
  );
}

export async function getServerSideProps({ res }: { res: any }) {
  // Short-circuit: gSSP calls res.end() directly instead of returning props.
  // This is a valid Next.js pattern for custom responses.
  res.setHeader("content-type", "application/json");
  res.statusCode = 202;
  res.end(JSON.stringify({ ok: true, source: "gssp-res-end" }));
  return { props: {} };
}
