import {createFormatter, createTranslator} from 'next-intl';

export default function CoreLibrary() {
  const t = createTranslator({
    locale: 'en',
    messages: {Index: {title: 'Relative time:'}}
  });

  const now = new Date(2022, 10, 6, 20, 20, 0, 0);
  const format = createFormatter({locale: 'en', now});
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return (
    <p data-testid="CoreLibrary">
      {t('Index.title')} {format.relativeTime(tomorrow)}
    </p>
  );
}
