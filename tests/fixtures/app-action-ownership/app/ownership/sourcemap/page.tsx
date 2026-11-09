import { ClientButtons } from "./client-buttons";
import { WorkerStarter } from "./worker-starter";

async function inlineCachedFunction() {
  "use cache";
  return "INLINE_CACHED_FUNCTION_BODY_MARKER";
}

export default async function Page() {
  async function inlineServerAction() {
    "use server";
    console.log("INLINE_SERVER_ACTION_BODY_MARKER");
  }

  return (
    <main>
      <p data-testid="inline-cached">{await inlineCachedFunction()}</p>
      <form action={inlineServerAction}>
        <button type="submit">Submit inline action</button>
      </form>
      <ClientButtons />
      <WorkerStarter />
    </main>
  );
}
