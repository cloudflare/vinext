import { markerA } from "./a";
import "./b.css";

export function markerB() {
  return `b-${markerA}`;
}
