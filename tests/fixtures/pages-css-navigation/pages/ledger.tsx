import { ledgerItem } from "../components/ledger";

export default function Ledger() {
  return (
    <p data-page="ledger" data-probe="text" className={`app-text ${ledgerItem}`}>
      Ledger
    </p>
  );
}
