import { Link } from "../../i18n/navigation";

// next-intl's Link reads NextIntlClientProvider's context, so this boundary
// only renders inside the [locale] layout (issue #4045).
export default function LocaleNotFound() {
  return (
    <div>
      <h1 data-testid="locale-not-found">Locale page not found</h1>
      <Link href="/">Home</Link>
    </div>
  );
}
