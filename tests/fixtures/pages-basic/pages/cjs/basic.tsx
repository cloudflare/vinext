const { random } = require("./random");

export default function Page() {
  return <div data-testid="cjs-basic">Random: {random()}</div>;
}
