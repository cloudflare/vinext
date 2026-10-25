import Link from "next/link";
import QueueForm from "./queue-form";

const targets = Array.from({ length: 8 }, (_, index) => index + 1);

// More viewport-prefetched links than the four concurrent prefetch requests,
// above a spacer tall enough to scroll them all out of view. `?shared` repeats
// the links further down with a hash, so both copies share one request.
// `?form` adds a Link above them, so its prefetch is issued last and queues,
// and further down a Form with the same destination.
export default async function PrefetchQueueViewportPage({
  searchParams,
}: {
  searchParams: Promise<{ form?: string; shared?: string }>;
}) {
  const { form, shared } = await searchParams;
  return (
    <main>
      {form === undefined ? null : (
        <Link id="form-link" href="/prefetch-queue-viewport/9">
          Form target
        </Link>
      )}
      <ul>
        {targets.map((target) => (
          <li key={target}>
            <Link className="queued-link" href={`/prefetch-queue-viewport/${target}`}>
              Target {target}
            </Link>
          </li>
        ))}
      </ul>
      {shared === undefined ? null : (
        <ul style={{ marginTop: "1500px" }}>
          {targets.map((target) => (
            <li key={target}>
              <Link className="shared-link" href={`/prefetch-queue-viewport/${target}#again`}>
                Again {target}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {form === undefined ? null : (
        <div style={{ marginTop: "1300px" }}>
          <QueueForm />
        </div>
      )}
      <div style={{ height: "6000px" }} />
      <p id="bottom">Bottom</p>
    </main>
  );
}
