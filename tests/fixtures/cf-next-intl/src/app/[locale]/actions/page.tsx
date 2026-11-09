import pick from '@/utils/pick';
import {NextIntlClientProvider, useLocale, useMessages} from 'next-intl';
import List from './List';
import ListItemAsync from './ListItemAsync';
import ListItemClient from './ListItemClient';
import ZodFormExample from './ZodFormExample';

export default function ServerActions() {
  const locale = useLocale();

  return (
    <>
      <ZodFormExample />
      <List
        getNextItem={async (curLength: number) => {
          'use server';
          const id = curLength + 1;
          return <ListItemAsync locale={locale} id={id} />;
        }}
        title="Async Server Components"
      />
      <NextIntlClientProvider messages={pick(useMessages(), ['ServerActions'])}>
        <List
          getNextItem={async (curLength: number) => {
            'use server';
            const id = curLength + 1;
            return <ListItemClient id={id} />;
          }}
          title="Client Components"
        />
      </NextIntlClientProvider>
    </>
  );
}
