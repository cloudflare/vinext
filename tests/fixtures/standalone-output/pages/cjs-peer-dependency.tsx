import { themeLabel } from "fake-cjs-theme-lib";

// Rendered per request so the standalone server loads the CommonJS external,
// and through its `#imports` entry the peer dependency it requires.
export function getServerSideProps() {
  return { props: { label: themeLabel("CommonJS peer dependency page") } };
}

export default function CjsPeerDependency({ label }: { label: string }) {
  return <h1 id="cjs-peer-dependency">{label}</h1>;
}
