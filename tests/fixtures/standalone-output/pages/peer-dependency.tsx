import { styledLabel } from "fake-styled-lib";

// Rendered per request so the standalone server loads the external package,
// and through it the peer dependency the page never imports directly.
export function getServerSideProps() {
  return { props: { label: styledLabel("Peer dependency page") } };
}

export default function PeerDependency({ label }: { label: string }) {
  return <h1 id="peer-dependency">{label}</h1>;
}
