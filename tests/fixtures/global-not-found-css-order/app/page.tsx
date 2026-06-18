Object.assign(globalThis, {
  __loadReactDomServerForChunkingTest: () => import("react-dom/server.edge"),
});

export default function Page() {
  return <p>hello world</p>;
}
