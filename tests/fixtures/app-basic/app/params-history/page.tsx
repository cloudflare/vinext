import Link from "next/link";

export default function ParamsHistoryListPage() {
  return (
    <div>
      <h1 id="params-history-title">Params history list</h1>
      <Link id="params-history-item" href="/params-history/item-1">
        Item 1
      </Link>
    </div>
  );
}
