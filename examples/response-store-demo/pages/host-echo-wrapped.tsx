import { withHostProps } from "../lib/with-host-props";

function HostEchoWrapped({ host }: { host: string }) {
  return <output data-testid="host">{host}</output>;
}

export default withHostProps(HostEchoWrapped);
