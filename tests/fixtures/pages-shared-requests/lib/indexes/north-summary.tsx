import { Chip } from "../kit";
import { NORTH_INDEX, northUnit } from "./north-index";

export function NorthSummary() {
  return (
    <p data-marker="marker-north-summary">
      <Chip>{northUnit()}</Chip>
      {NORTH_INDEX.length}
    </p>
  );
}
