import Link from "next/link";

export function getServerSideProps({ locale, defaultLocale }) {
  return { props: { locale, defaultLocale } };
}

export default function About({ locale, defaultLocale }) {
  return (
    <div>
      <p id="locale">{locale}</p>
      <p id="defaultLocale">{defaultLocale}</p>
      <Link href="/about" locale="fr" id="switch-locale">
        Switch locale
      </Link>
    </div>
  );
}
