import ReactDOM from "react-dom";

export default function ConfigLinkPreloadPage() {
  ReactDOM.preload("/agent-test.woff2", {
    as: "font",
    crossOrigin: "anonymous",
    type: "font/woff2",
  });

  return <main>Config Link preload test</main>;
}
