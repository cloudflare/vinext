import { unselectedAction } from "../unselected-actions";

export default function UnselectedPage() {
  return (
    <form action={unselectedAction}>
      <button type="submit">Run lazily loaded action</button>
    </form>
  );
}
