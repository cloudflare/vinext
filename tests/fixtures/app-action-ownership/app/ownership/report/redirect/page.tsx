import { redirectTo } from "./actions";

export default function Page() {
  return (
    <form action={redirectTo.bind(null, "/ownership/report/public")}>
      <button>redirect</button>
    </form>
  );
}
