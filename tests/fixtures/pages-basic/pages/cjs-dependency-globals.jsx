import { readCjsModuleIdentity } from "../lib/cjs-module-identity";

export function getServerSideProps() {
  return {
    props: readCjsModuleIdentity(),
  };
}

export function CjsDependencyGlobalsView({
  runtimePath,
  projectRuntimePath,
  types,
  consistent,
  localRuntimePath,
  localTypes,
  shadowedProcess,
  userMarkerTypes,
}) {
  return (
    <>
      <p id="runtime-path">{runtimePath}</p>
      <p id="project-runtime-path">{projectRuntimePath}</p>
      <p id="identity-types">{types}</p>
      <p id="identity-consistent">{String(consistent)}</p>
      <p id="local-runtime-path">{localRuntimePath}</p>
      <p id="local-identity-types">{localTypes}</p>
      <p id="shadowed-process">{shadowedProcess}</p>
      <p id="user-marker-types">{userMarkerTypes}</p>
    </>
  );
}

export default CjsDependencyGlobalsView;
