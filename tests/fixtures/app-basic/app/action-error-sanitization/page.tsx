import { throwFormAction } from "./actions";
import { ActionErrorTrigger } from "./trigger";

export default function ActionErrorSanitizationPage() {
  return (
    <main>
      <h1>Action Error Sanitization</h1>
      <ActionErrorTrigger />
      <form action={throwFormAction}>
        <button id="submit-form" type="submit">
          Submit form
        </button>
      </form>
    </main>
  );
}
