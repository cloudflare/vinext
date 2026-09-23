import * as Sentry from '@sentry/nextjs';

export const GET = async () => {
  Sentry.metrics.count('test.route.handler.count', 1, {
    attributes: {
      endpoint: '/metrics/route-handler',
      'random.attribute': 'Potatoes',
    },
  });
  Sentry.metrics.distribution('test.route.handler.distribution', 100, {
    attributes: {
      endpoint: '/metrics/route-handler',
      'random.attribute': 'Patatas',
    },
  });
  Sentry.metrics.gauge('test.route.handler.gauge', 200, {
    attributes: {
      endpoint: '/metrics/route-handler',
      'random.attribute': 'Patate',
    },
  });
  return Response.json({ message: 'Bueno' });
};
