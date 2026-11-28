import { CardSection1 } from "./card-section-1";
import { CardSection2 } from "./card-section-2";
import { CardSection3 } from "./card-section-3";
import { CardSection4 } from "./card-section-4";
import { CardSection5 } from "./card-section-5";
import { CardSection6 } from "./card-section-6";

// The card list: 6 sections that are over 20 kB together.
export function CardList() {
  return (
    <div data-marker="marker-card-list">
      <CardSection1 />
      <CardSection2 />
      <CardSection3 />
      <CardSection4 />
      <CardSection5 />
      <CardSection6 />
    </div>
  );
}
