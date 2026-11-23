// The project root's package.json declares `"type": "commonjs"`. The Pages
// Router server output must still load as ESM.
export default function HomePage({ renderedBy }: { renderedBy: string }) {
  return <h1 id="cjs-package-scope-pages">CJS Package Scope Pages {renderedBy}</h1>;
}

export function getServerSideProps() {
  return { props: { renderedBy: "getServerSideProps" } };
}
