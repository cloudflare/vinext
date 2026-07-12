import { RevalidateForm } from "./revalidate-form";

export default async function ActionRevalidatePage() {
  await new Promise((resolve) => setTimeout(resolve, 200));

  return (
    <main>
      <h1>Action revalidation</h1>
      <p>
        Increment the client count, then revalidate the path. The timestamp should change without
        resetting the client count or mounting the loading fallback.
      </p>
      <p data-testid="action-revalidate-time">Rendered at: {Date.now()}</p>
      <RevalidateForm />
      <a href="/">Back to home</a>
    </main>
  );
}
