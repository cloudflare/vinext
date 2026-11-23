"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Builds its collection the way react-aria-components' CollectionBuilder does
// during SSR: a hidden copy of the children registers each item as it renders,
// then a sibling renders the real markup from what was registered. It relies on
// the hidden children rendering, in order, before the sibling does.
const CollectionDocumentContext = createContext<string[] | null>(null);

export function Collection({ children }: { children: ReactNode }) {
  const [items] = useState<string[]>(() => []);
  return (
    <>
      <template>
        <CollectionDocumentContext.Provider value={items}>
          {children}
        </CollectionDocumentContext.Provider>
      </template>
      <CollectionInner items={items} />
    </>
  );
}

function CollectionInner({ items }: { items: string[] }) {
  return (
    <table id="collection">
      <tbody>
        {items.map((text) => (
          <tr key={text}>
            <td>{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Cell({ text }: { text: string }) {
  const items = useContext(CollectionDocumentContext);
  if (items && !items.includes(text)) items.push(text);
  return null;
}
