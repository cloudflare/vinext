import { RenderId } from "../../fixture-parts";
import { ClientBoundary } from "./client-boundary";

export default function Page() {
  return (
    <main>
      <RenderId />
      <ClientBoundary />
    </main>
  );
}
