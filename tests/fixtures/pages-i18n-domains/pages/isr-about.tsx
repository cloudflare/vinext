export function getStaticProps({ locale, defaultLocale }) {
  return {
    props: {
      locale,
      defaultLocale,
      renderedAt: Date.now(),
    },
    revalidate: 60,
  };
}

export default function IsrAbout({ locale, defaultLocale, renderedAt }) {
  return (
    <main>
      <h1>ISR About</h1>
      <p id="locale">{locale}</p>
      <p id="defaultLocale">{defaultLocale}</p>
      <p id="renderedAt">{renderedAt}</p>
    </main>
  );
}
