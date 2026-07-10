export function getStaticProps({ locale, defaultLocale }) {
  return {
    props: { locale, defaultLocale, renderedAt: Date.now() },
    revalidate: 3600,
  };
}

export default function IsrAbout({ locale, defaultLocale, renderedAt }) {
  return (
    <main>
      <p id="locale">{locale}</p>
      <p id="defaultLocale">{defaultLocale}</p>
      <p id="renderedAt">{renderedAt}</p>
    </main>
  );
}
