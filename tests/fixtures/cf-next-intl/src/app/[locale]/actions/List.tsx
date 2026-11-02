'use client';

import {ReactNode, useEffect, useState} from 'react';

type Props = {
  getNextItem(curLength: number): Promise<ReactNode>;
  title: string;
};

export default function List({getNextItem, title}: Props) {
  const [isMounted, setIsMounted] = useState(false);
  const [items, setItems] = useState<Array<ReactNode>>([]);

  function onAddItem() {
    getNextItem(items.length).then((item) => {
      setItems([...items, item]);
    });
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMounted(true);
  }, []);

  return (
    <section>
      <h2>{title}</h2>
      <p>{isMounted && 'Mounted'}</p>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      <button onClick={onAddItem} type="button">
        Add item
      </button>
    </section>
  );
}
