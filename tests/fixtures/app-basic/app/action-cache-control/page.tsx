import { failAction, redirectToConfigPolicy, setTheme } from "./actions";

export default function ActionCacheControlPage() {
  return (
    <main>
      <form action={setTheme}>
        <button>Set theme</button>
      </form>
      <form action={failAction}>
        <button>Fail</button>
      </form>
      <form action={redirectToConfigPolicy}>
        <button>Redirect</button>
      </form>
    </main>
  );
}
