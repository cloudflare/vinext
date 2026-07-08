import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function updateCookiesAndRedirect() {
  "use server";

  const cookieStore = await cookies();
  cookieStore.delete("stale");
  cookieStore.set("theme", "dark");
  redirect("/nextjs-compat/action-redirect-cookies/target?baz=1");
}

export default async function Page() {
  const cookieStore = await cookies();

  return (
    <main>
      <h1>Action Redirect Cookies</h1>
      <p id="source-theme">{cookieStore.get("theme")?.value ?? "missing"}</p>
      <form action={updateCookiesAndRedirect}>
        <button id="redirect-with-cookie-mutation" type="submit">
          Redirect with cookies
        </button>
      </form>
    </main>
  );
}
