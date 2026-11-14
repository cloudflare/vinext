import { setTheme } from "../actions";

// next.config.ts gives this path a shared-cache Cache-Control rule.
export default function ActionCacheControlConfigPolicyPage() {
  return (
    <main>
      <p id="action-cache-control-config-policy">config policy</p>
      <form action={setTheme}>
        <button>Set theme</button>
      </form>
    </main>
  );
}
