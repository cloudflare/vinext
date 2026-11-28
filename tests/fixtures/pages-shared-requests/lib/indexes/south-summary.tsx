import { Chip } from "../kit";
import { SOUTH_INDEX, southUnit } from "./south-index";

export function SouthSummary() {
  return (
    <p data-marker="marker-south-summary">
      <Chip>{southUnit()}</Chip>
      {SOUTH_INDEX.length}
    </p>
  );
}
