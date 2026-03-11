import { getHeaderFromAction, getCookieFromAction } from "./actions";

/**
 * Thin wrappers matching the `(formData: FormData) => Promise<void>` type
 * expected by form actions. The actual action under test is imported above.
 */
async function formGetHeader(_formData: FormData): Promise<void> {
  "use server";
  await getHeaderFromAction("x-test-header");
}

async function formGetCookie(_formData: FormData): Promise<void> {
  "use server";
  await getCookieFromAction("test-cookie");
}

export default function ActionHeadersPage() {
  return (
    <main>
      <h1>Action Headers Test</h1>
      {/* Form bound to getHeaderFromAction — action ID extracted by tests */}
      <form action={formGetHeader}>
        <button id="get-header-btn" type="submit">
          Get Header
        </button>
      </form>
      {/* Form bound to getCookieFromAction — action ID extracted by tests */}
      <form action={formGetCookie}>
        <button id="get-cookie-btn" type="submit">
          Get Cookie
        </button>
      </form>
    </main>
  );
}
