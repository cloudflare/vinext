import {defineRouting} from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'de', 'es', 'ja', 'nl'],
  defaultLocale: 'en',
  localePrefix:
    process.env.NEXT_PUBLIC_USE_CASE === 'locale-prefix-never'
      ? 'never'
      : {
          mode: 'as-needed',
          prefixes: {
            es: '/spain'
          }
        },
  domains:
    process.env.NEXT_PUBLIC_USE_CASE === 'domains'
      ? [
          {
            domain: 'example.com',
            defaultLocale: 'en',
            locales: ['en', 'es', 'ja']
          },
          {
            domain: 'example.de',
            defaultLocale: 'de',
            locales: ['de']
          }
        ]
      : process.env.NEXT_PUBLIC_USE_CASE === 'domains-locale-prefix'
        ? [
            {
              domain: 'never.example.com',
              defaultLocale: 'nl',
              locales: ['nl'],
              localePrefix: 'never'
            },
            {
              domain: 'always.example.com',
              defaultLocale: 'de',
              locales: ['en', 'de'],
              localePrefix: 'always'
            },
            {
              domain: 'as-needed.example.com',
              defaultLocale: 'ja',
              locales: ['ja', 'es'],
              localePrefix: 'as-needed'
            }
          ]
        : undefined,
  pathnames: {
    '/': '/',
    '/client': '/client',
    '/about': '/about',
    '/client/redirect': '/client/redirect',
    '/nested': {
      en: '/nested',
      de: '/verschachtelt',
      es: '/anidada',
      ja: '/ネスト',
      nl: '/genest'
    },
    '/news/[articleId]': {
      en: '/news/[articleId]',
      de: '/neuigkeiten/[articleId]',
      es: '/noticias/[articleId]',
      ja: '/ニュース/[articleId]',
      nl: '/nieuws/[articleId]'
    },
    '/news/just-in': {
      en: '/news/just-in',
      de: '/neuigkeiten/aktuell',
      es: '/noticias/justo-en',
      ja: '/ニュース/現在',
      nl: '/nieuws/net-binnen'
    }
  },
  localeCookie:
    process.env.NEXT_PUBLIC_USE_CASE === 'locale-cookie-false'
      ? false
      : {
          // 200 days
          maxAge: 200 * 24 * 60 * 60
        }
});
