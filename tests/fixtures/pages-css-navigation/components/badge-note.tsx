import { badgeText } from "./badge";

export default function BadgeNote() {
  return (
    <p data-probe="note" className={`app-text ${badgeText}`}>
      Badge note
    </p>
  );
}
