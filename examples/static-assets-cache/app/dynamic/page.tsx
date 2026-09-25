export const dynamic = "force-dynamic";

export default function DynamicPage() {
  return (
    <>
      <h1>Dynamic page</h1>
      <p>
        Request <span id="request-id">{crypto.randomUUID()}</span> was rendered by the Worker.
      </p>
    </>
  );
}
