import { ledgerItem } from "../components/ledger";
import { galleryItem } from "../components/gallery";

export default function Reversed() {
  return (
    <p data-page="reversed" data-probe="text" className={`app-text ${galleryItem} ${ledgerItem}`}>
      Reversed
    </p>
  );
}
