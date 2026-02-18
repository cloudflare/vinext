import { redirect } from "next/navigation";

export default function ExternalRedirectPage() {
  return (
    <div>
      <h1 id="external-redirect">External Redirect Test</h1>
      <form
        action={async () => {
          "use server";
          redirect("https://example.com");
        }}
      >
        <button type="submit" id="redirect-external">
          Redirect External
        </button>
      </form>
    </div>
  );
}
