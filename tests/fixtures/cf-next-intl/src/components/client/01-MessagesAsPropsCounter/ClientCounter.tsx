'use client';

import {useState} from 'react';

type Props = {
  messages: {
    count: string;
    increment: string;
  };
};

export default function ClientCounter({messages}: Props) {
  const [count, setCount] = useState(0);

  function onIncrement() {
    setCount(count + 1);
  }

  return (
    <div data-testid="MessagesAsPropsCount">
      <p>
        {messages.count} {count}
      </p>
      <button onClick={onIncrement} type="button">
        {messages.increment}
      </button>
    </div>
  );
}
