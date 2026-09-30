import { VERSION } from "../version";

export default function StaleWidget() {
  return <p id="stale-widget">STALE_WIDGET_MARKER {VERSION}</p>;
}
