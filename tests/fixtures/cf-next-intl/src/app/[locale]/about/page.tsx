import {getLocale} from 'next-intl/server';

export default async function AboutPage() {
  const locale = await getLocale();
  const Content = (await import(`./${locale}.mdx`)).default;
  return <Content />;
}
