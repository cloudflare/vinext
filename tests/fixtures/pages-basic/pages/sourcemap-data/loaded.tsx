export default function LoadedPage({ value }: { value: string }) {
  return <p id="sourcemap-data-loaded">SOURCEMAP_LOADED_COMPONENT {value}</p>;
}

export async function getServerSideProps() {
  return { props: { value: `SOURCEMAP_LOADED_SERVER_PROPS`.length.toString() } };
}
