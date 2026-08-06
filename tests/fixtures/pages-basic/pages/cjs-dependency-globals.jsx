import regeneratorRuntimePath from "next/dist/compiled/regenerator-runtime/path";

export function getServerSideProps() {
  return {
    props: {
      runtimePath: regeneratorRuntimePath.path,
    },
  };
}

export default function CjsDependencyGlobals({ runtimePath }) {
  return <p id="runtime-path">{runtimePath}</p>;
}
