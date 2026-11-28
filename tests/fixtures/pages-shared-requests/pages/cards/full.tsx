import { CardList } from "../../lib/cards/card-list";
import { cardTitle } from "../../lib/cards/card-title";

export default function CardsFull() {
  return (
    <main data-page="cards/full">
      <h1>{cardTitle("Full")}</h1>
      <CardList />
    </main>
  );
}
