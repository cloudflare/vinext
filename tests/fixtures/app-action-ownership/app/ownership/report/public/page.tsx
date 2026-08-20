import { redirectTo } from "../redirect/actions";

export default function Page() {
  return (
    <form action={redirectTo.bind(null, "/ownership/report/public")}>
      <button>Public action caller</button>
    </form>
  );
}
