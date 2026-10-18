import pick from '@/utils/pick';
import {NextIntlClientProvider, useMessages} from 'next-intl';
import ClientCounter from './ClientCounter';

export default function Counter() {
  const messages = useMessages();

  return (
    <NextIntlClientProvider
      messages={
        // Only provide the minimum of messages
        pick(messages, 'ClientCounter')
      }
    >
      <ClientCounter />
    </NextIntlClientProvider>
  );
}
