// vinext: not in next-intl's playground. A static page that is regenerated
// after it goes stale. The request config resolves the locale from
// `next/root-params`, so the regeneration must see the request's `[locale]`.
import {getLocale} from 'next-intl/server';

export const dynamic = 'force-static';
export const revalidate = 1;

export default async function Isr() {
  const locale = await getLocale();

  return (
    <>
      <p data-testid="isr-locale">{locale}</p>
      <p data-testid="isr-rendered-at">{Date.now()}</p>
    </>
  );
}
