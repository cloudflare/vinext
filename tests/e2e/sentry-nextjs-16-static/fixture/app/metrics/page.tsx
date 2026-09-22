'use client';

import * as Sentry from '@sentry/nextjs';

export default function Page() {
  const handleClick = async () => {
    Sentry.metrics.count('test.page.count', 1, {
      attributes: {
        page: '/metrics',
        'random.attribute': 'Apples',
      },
    });
    Sentry.metrics.distribution('test.page.distribution', 100, {
      attributes: {
        page: '/metrics',
        'random.attribute': 'Manzanas',
      },
    });
    Sentry.metrics.gauge('test.page.gauge', 200, {
      attributes: {
        page: '/metrics',
        'random.attribute': 'Mele',
      },
    });
    await fetch('/metrics/route-handler');
  };

  return (
    <div>
      <h1>Metrics page</h1>
      <button onClick={handleClick}>Emit</button>
    </div>
  );
}
