import { Slot } from "radix-ui";
import Link from "next/link";
import Controls from "./controls";

export default function Page() {
  return (
    <main>
      <Slot.Root data-testid="server-slot">
        <h1>Radix barrel imports</h1>
      </Slot.Root>
      <Controls />
      <Link href="/about">About this fixture</Link>
    </main>
  );
}
