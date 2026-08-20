import { globalNotFoundOnlyAction } from "./global-not-found-action";

export default function GlobalNotFound() {
  return (
    <html>
      <body>
        <form action={globalNotFoundOnlyAction}>Global not-found action</form>
      </body>
    </html>
  );
}
