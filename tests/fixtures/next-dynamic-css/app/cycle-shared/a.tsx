import { markerB } from "./b";
import "./a.css";

export const markerA = "a";

export function CycleShared() {
  return (
    <p id="cycle-shared" className="cycle-shared" data-marker={markerB()}>
      Cyclic shared styles retain evaluation order
    </p>
  );
}
