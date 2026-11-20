import { panelText } from "../components/panel";

export default function Plain() {
  return (
    <p data-page="plain" data-probe="text" className={`app-text ${panelText}`}>
      Plain
    </p>
  );
}
