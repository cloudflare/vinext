export async function getServerSideProps() {
  const [{ default: literal }, { default: template }] = await Promise.all([
    import("@shared/literal-dynamic-world.js"),
    import(`@shared/dynamic-world.js`),
  ]);
  return { props: { value: literal + "+" + template } };
}

export default function Page({ value }) {
  return <p>Dynamic:{value}</p>;
}
