'use client';

import {useTranslations} from 'next-intl';
import {useState} from 'react';

export default function ClientCounter() {
  const t = useTranslations('ClientCounter');
  const [count, setCount] = useState(0);

  function onIncrement() {
    setCount(count + 1);
  }

  return (
    <div data-testid="MessagesOnClientCounter">
      <p>{t('count', {count: String(count)})}</p>
      <button onClick={onIncrement} type="button">
        {t('increment')}
      </button>
    </div>
  );
}
