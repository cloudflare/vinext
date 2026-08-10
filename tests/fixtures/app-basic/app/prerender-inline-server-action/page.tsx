import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { Form } from "./form";

// Ported from Next.js:
// test/e2e/app-dir/cache-components/cache-components.server-action.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.server-action.test.ts
export default function Page() {
  const simpleValue = "result";
  const jsxValue = <span>and more</span>;
  const timedValue = <HasTimingInfo />;

  return (
    <>
      <Form
        action={async () => {
          "use server";
          return (
            <>
              {simpleValue} {jsxValue} {timedValue}
            </>
          );
        }}
      />
      <div id="phase">
        {process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD ? "at buildtime" : "at runtime"}
      </div>
    </>
  );
}

async function HasTimingInfo() {
  await Promise.resolve();
  return "and even more";
}
