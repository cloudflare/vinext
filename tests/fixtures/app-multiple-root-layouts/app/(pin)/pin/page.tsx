import { submitPin } from "./actions";

export default function PinPage() {
  return (
    <form action={submitPin}>
      <input id="pin-input" name="pin" defaultValue="9999" />
      <button id="submit-pin" type="submit">
        Unlock
      </button>
    </form>
  );
}
