import { redirectAction, redirectBoundAction, redirectOtherAction } from "./actions";

export default function Page() {
  return (
    <main>
      <h1>Progressive action process fixture</h1>
      <form action={redirectAction}>
        <button type="submit">Run action</button>
      </form>
      <form action={redirectOtherAction}>
        <button type="submit">Run other action</button>
      </form>
      <form action={redirectBoundAction.bind(null, "/bound-success")}>
        <button type="submit">Run bound action</button>
      </form>
    </main>
  );
}
