import { redirect } from "next/navigation";

async function doRedirect() {
  "use server";
  redirect("/about");
}

export default function RedirectFromActionPage() {
  return (
    <form action={doRedirect}>
      <button type="submit">Redirect</button>
    </form>
  );
}
