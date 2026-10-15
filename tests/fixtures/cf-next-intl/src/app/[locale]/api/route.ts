import {NextRequest, NextResponse} from 'next/server';
import {hasLocale} from 'next-intl';
import {getTranslations} from 'next-intl/server';
import {routing} from '@/i18n/routing';

export async function GET(
  request: NextRequest,
  props: RouteContext<'/[locale]/api'>
) {
  const params = await props.params;
  const {locale} = params;

  if (!hasLocale(routing.locales, locale)) {
    return new Response('Invalid locale', {status: 400});
  }

  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return new Response('Search param `name` was not provided.', {status: 400});
  }

  const t = await getTranslations({
    locale,
    namespace: 'ApiRoute'
  });
  return NextResponse.json({message: t('hello', {name})});
}
