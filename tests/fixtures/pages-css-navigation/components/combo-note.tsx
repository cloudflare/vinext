import { badgeText } from "./badge";
import { chipText } from "./chip";

export default function ComboNote() {
  return (
    <p data-probe="note" className={`app-text ${badgeText} ${chipText}`}>
      Combo note
    </p>
  );
}
