"use client";

import { useState } from "react";

export function OrderList({
  getOrders,
  echoLabel,
}: {
  getOrders: (query?: string) => Promise<string[]>;
  echoLabel: () => Promise<string>;
}) {
  const [orders, setOrders] = useState<string[] | null>(null);
  const [label, setLabel] = useState<string | null>(null);

  return (
    <>
      <button id="load-orders" onClick={async () => setOrders(await getOrders())}>
        Load orders
      </button>
      <button id="echo-label" onClick={async () => setLabel(await echoLabel())}>
        Echo label
      </button>
      <p id="orders">{orders?.join(",")}</p>
      <p id="label">{label}</p>
    </>
  );
}
