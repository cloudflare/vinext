"use client";

import { useEffect, useState } from "react";
import { Dialog, Slot } from "radix-ui";

export default function Controls() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <>
      <Slot.Root onClick={() => setCount((value) => value + 1)}>
        <button type="button" disabled={!hydrated}>
          Count: {count}
        </button>
      </Slot.Root>
      <Dialog.Root>
        <Dialog.Trigger asChild>
          <button type="button">Open dialog</button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Radix dialog</Dialog.Title>
            <Dialog.Description>Rendered through the radix-ui barrel.</Dialog.Description>
            <Dialog.Close asChild>
              <button type="button">Close dialog</button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
