import Image from 'next/image';
import {useFormatter, useNow, useTimeZone, useTranslations} from 'next-intl';
import {use} from 'react';
import DropdownMenu from '@/components/DropdownMenu';
import RichText from '@/components/RichText';
import {Link} from '@/i18n/navigation';
import AsyncComponent from '../../components/AsyncComponent';
import AsyncComponentWithNamespaceAndLocale from '../../components/AsyncComponentWithNamespaceAndLocale';
import AsyncComponentWithoutNamespace from '../../components/AsyncComponentWithoutNamespace';
import AsyncComponentWithoutNamespaceAndLocale from '../../components/AsyncComponentWithoutNamespaceAndLocale';
import ClientLink from '../../components/ClientLink';
import ClientRouter from '../../components/ClientRouter';
import CoreLibrary from '../../components/CoreLibrary';
import LocaleSwitcher from '../../components/LocaleSwitcher';
import PageLayout from '../../components/PageLayout';
import MessagesAsPropsCounter from '../../components/client/01-MessagesAsPropsCounter';
import MessagesOnClientCounter from '../../components/client/02-MessagesOnClientCounter';

type Props = {
  searchParams: Promise<Record<string, string>>;
};

export default function Index(props: Props) {
  const searchParams = use(props.searchParams);
  const t = useTranslations('Index');
  const format = useFormatter();
  const now = useNow();
  const timeZone = useTimeZone();

  return (
    <PageLayout title={t('title')}>
      <p>{t('description')}</p>
      <RichText data-testid="RichText">
        {(tags) => t.rich('rich', tags)}
      </RichText>
      <p
        dangerouslySetInnerHTML={{__html: t.raw('rich')}}
        data-testid="RawText"
      />
      {/* @ts-expect-error Purposefully trigger an error */}
      <p data-testid="MissingMessage">{t('missing')}</p>
      <p data-testid="CurrentTime">
        {format.dateTime(now, 'medium')} ({timeZone || 'N/A'})
      </p>
      <p data-testid="CurrentTimeRelative">{format.relativeTime(now)}</p>
      <p data-testid="Number">
        {format.number(23102, {style: 'currency', currency: 'EUR'})}
      </p>
      <LocaleSwitcher />
      <MessagesAsPropsCounter />
      <MessagesOnClientCounter />
      <CoreLibrary />
      <ClientRouter />
      <div>
        <Link href={{pathname: '/', query: {test: true}}}>
          Go to home with query param
        </Link>
      </div>
      <ClientLink href="/">Link on client without provider</ClientLink>
      <p data-testid="SearchParams">{JSON.stringify(searchParams, null, 2)}</p>
      <p data-testid="HasTitle">{JSON.stringify(t.has('title'))}</p>
      <Image alt="" height={77} priority src="/assets/image.jpg" width={128} />
      <AsyncComponent />
      <AsyncComponentWithNamespaceAndLocale />
      <AsyncComponentWithoutNamespace />
      <AsyncComponentWithoutNamespaceAndLocale />
      <DropdownMenu />
    </PageLayout>
  );
}
