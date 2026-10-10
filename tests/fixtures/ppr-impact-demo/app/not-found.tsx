import { NotFoundPing } from "./not-found-ping";

export default function NotFound() {
  return (
    <main>
      <h1 id="app-not-found">Not found</h1>
      <p>No route matches this URL.</p>
      <NotFoundPing />
    </main>
  );
}
