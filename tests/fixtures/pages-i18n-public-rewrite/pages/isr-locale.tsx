export function getStaticProps({ locale }) {
  return {
    props: { locale, renderedAt: Date.now() },
    revalidate: 60,
  };
}

export default function IsrLocale({ locale, renderedAt }) {
  return (
    <main>
      <p id="locale">{locale}</p>
      <p id="renderedAt">{renderedAt}</p>
    </main>
  );
}
