import { RootRethrow } from "../root-rethrow";

// global-error.tsx throws in the browser for this route.
export default function Page() {
  return <RootRethrow />;
}
