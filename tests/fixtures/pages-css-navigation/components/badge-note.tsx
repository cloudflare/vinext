import { badgeText } from "./badge";

export default function BadgeNote({ className = "" }: { className?: string }) {
  return (
    <p data-probe="note" className={`app-text ${className} ${badgeText}`}>
      Badge note
    </p>
  );
}
