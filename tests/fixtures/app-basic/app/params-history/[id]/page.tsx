import Link from "next/link";
import { ParamsRecorder } from "./params-recorder";

export default function ParamsHistoryItemPage() {
  return (
    <div>
      <h1 id="params-history-title">Params history item</h1>
      <ParamsRecorder />
      <Link id="params-history-next" href="/params-history/item-2">
        Item 2
      </Link>
    </div>
  );
}
