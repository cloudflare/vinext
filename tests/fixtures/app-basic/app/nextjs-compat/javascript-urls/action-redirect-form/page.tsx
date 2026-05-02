import { redirect } from "next/navigation";
import { DANGEROUS_JAVASCRIPT_URL } from "../bad-url";

async function handleRedirect() {
  "use server";
  redirect(DANGEROUS_JAVASCRIPT_URL);
}

export default function Page() {
  return (
    <>
      <p>
        Clicking this button should result in an error where Next.js blocks a javascript URL through
        a server action redirect initiated by a form action.
      </p>
      <form action={handleRedirect}>
        <button type="submit">redirect via form action</button>
      </form>
      <a href="/nextjs-compat/javascript-urls/safe">safe page</a>
    </>
  );
}
