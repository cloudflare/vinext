import { after, connection } from "next/server";
import { setTimeout } from "node:timers/promises";

// Ported from Next.js: test/e2e/app-dir/graceful-shutdown-next-after/next-start/app/page.tsx
export default async function Page() {
  await connection();
  after(async () => {
    console.log("[after] starting sleep");
    await setTimeout(500);

    // An after() callback can schedule more after() work.
    after(async () => {
      await setTimeout(500);
      console.log("[after] finished sleep");
    });
  });
  return <p>Hello</p>;
}
