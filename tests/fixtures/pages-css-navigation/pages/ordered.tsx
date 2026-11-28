import { galleryItem } from "../components/gallery";
import { ledgerItem } from "../components/ledger";

export default function Ordered() {
  return (
    <p data-page="ordered" data-probe="text" className={`app-text ${galleryItem} ${ledgerItem}`}>
      Ordered
    </p>
  );
}
