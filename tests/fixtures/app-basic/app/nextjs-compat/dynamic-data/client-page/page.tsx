"use client";

import { PageSentinel } from "../getSentinelValue";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  return (
    <div>
      <PageSentinel />
      <section id="headers">
        <p>This is a client Page so headers() is not available</p>
      </section>
      <section id="cookies">
        <p>This is a client Page so cookies() is not available</p>
      </section>
      <section id="searchparams">
        {Object.entries(await searchParams).map(([key, value]) => (
          <pre key={key} className={key}>
            {value}
          </pre>
        ))}
      </section>
    </div>
  );
}
