"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ItemsContext, type Item } from "./context";

function createItems(start: number, end: number): Item[] {
  const items: Item[] = [];
  for (let id = start; id <= end; id += 1) {
    items.push({ id });
  }
  return items;
}

export default function Layout({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>(createItems(1, 50));

  const loadMoreItems = () => {
    setItems((prevItems) => {
      const start = prevItems.length + 1;
      const end = start + 50 - 1;
      return [...prevItems, ...createItems(start, end)];
    });
  };

  return <ItemsContext.Provider value={{ items, loadMoreItems }}>{children}</ItemsContext.Provider>;
}
