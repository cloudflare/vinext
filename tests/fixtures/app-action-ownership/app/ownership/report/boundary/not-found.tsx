import { boundaryOnlyAction } from "./actions";

export default function NotFound() {
  return <form action={boundaryOnlyAction}>Boundary action</form>;
}
