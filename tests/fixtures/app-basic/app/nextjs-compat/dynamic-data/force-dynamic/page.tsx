import { headers, cookies } from "next/headers";
import { connection } from "next/server";
import { PageSentinel } from "../getSentinelValue";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await connection();
  return (
    <div>
      <PageSentinel />
      <section id="headers">
        {Array.from((await headers()).entries()).map(([key, value]) => {
          if (key === "cookie") return null;
          return (
            <pre key={key} className={key}>
              {value}
            </pre>
          );
        })}
      </section>
      <section id="cookies">
        {(await cookies()).getAll().map((cookie) => (
          <pre key={cookie.name} className={cookie.name}>
            {cookie.value}
          </pre>
        ))}
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
