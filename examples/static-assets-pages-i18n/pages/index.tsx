import type { GetStaticPropsContext } from "next";

export function getStaticProps({ locale, defaultLocale }: GetStaticPropsContext) {
  return { props: { locale, defaultLocale } };
}

export default function Home({ locale, defaultLocale }: { locale: string; defaultLocale: string }) {
  return (
    <main>
      <h1>Static Assets Pages i18n</h1>
      <p id="locale">{locale}</p>
      <p id="default-locale">{defaultLocale}</p>
    </main>
  );
}
