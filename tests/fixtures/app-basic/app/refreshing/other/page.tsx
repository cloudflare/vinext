import Link from "next/link";
import {
  RefreshControl,
  RevalidateControl,
  SerializedRevalidateControl,
} from "../../parallel-revalidation-controls";

export default function Page() {
  return (
    <main data-testid="refreshing-other-page">
      <p data-testid="refreshing-other-token">{Math.random()}</p>
      <RefreshControl />
      <RevalidateControl />
      <SerializedRevalidateControl />
      <Link href="/refreshing">Go to Refreshing Page</Link>
    </main>
  );
}
