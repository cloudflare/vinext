import { createContext } from "react";

export type Item = {
  id: number;
};

export const ItemsContext = createContext<{
  items: Item[];
  loadMoreItems: () => void;
}>({ items: [], loadMoreItems: () => {} });
