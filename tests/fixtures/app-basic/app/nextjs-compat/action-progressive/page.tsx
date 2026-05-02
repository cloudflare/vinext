import { redirect } from "next/navigation";

async function submitAction(formData: FormData): Promise<void> {
  "use server";

  const params = new URLSearchParams();
  const name = formData.get("name");
  const hiddenInfo = formData.get("hidden-info");

  if (typeof name === "string") {
    params.set("name", name);
  }
  if (typeof hiddenInfo === "string") {
    params.set("hidden-info", hiddenInfo);
  }

  redirect(`/nextjs-compat/action-progressive/result?${params.toString()}`);
}

export default function ActionProgressivePage() {
  return (
    <main>
      <h1>Action Progressive Enhancement</h1>
      <form action={submitAction}>
        <input type="hidden" name="hidden-info" value="hi" />
        <input id="name" name="name" required />
        <button id="submit" type="submit">
          Submit
        </button>
      </form>
    </main>
  );
}
