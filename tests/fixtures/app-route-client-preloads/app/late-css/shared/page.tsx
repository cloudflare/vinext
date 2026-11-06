import { SharedPanel } from "./panel";
import { sharedRule } from "./shared-rule";
import "./page.css";

export const dynamic = "force-dynamic";

export default async function LateSharedPage() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return (
    <div className={sharedRule}>
      <SharedPanel />
    </div>
  );
}
