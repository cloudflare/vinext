import { Counter } from "../../nested/[section]/counter";

export default function SiblingChildPage() {
  return (
    <div>
      <h3>Sibling layout child</h3>
      <Counter id="sibling-child" label="Child counter" />
    </div>
  );
}
