import {formats} from '@/i18n/request-config';
import {routing} from '@/i18n/routing';
import messages from './messages/en.json';

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Formats: typeof formats;
    Messages: typeof messages;
  }
}
