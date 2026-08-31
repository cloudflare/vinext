import { submit } from "../helper";

export function HelperResult() {
  return <output data-testid="same-name-helper-result">{submit()}</output>;
}
