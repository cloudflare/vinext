import {defineRouting} from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  pathnames: {
    '/': '/',
    '/pathnames': {
      de: '/pfadnamen'
    }
  }
});
