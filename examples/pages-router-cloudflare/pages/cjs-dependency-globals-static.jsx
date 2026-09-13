import { readCjsModuleIdentity } from "../lib/cjs-module-identity";
import { CjsDependencyGlobalsView } from "./cjs-dependency-globals";

export function getStaticProps() {
  return { props: readCjsModuleIdentity() };
}

export default CjsDependencyGlobalsView;
