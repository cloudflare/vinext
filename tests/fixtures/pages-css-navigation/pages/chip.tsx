import { chipText } from "../components/chip";

export default function Chip() {
  return (
    <p data-page="chip" data-probe="text" className={`app-text ${chipText}`}>
      Chip
    </p>
  );
}
