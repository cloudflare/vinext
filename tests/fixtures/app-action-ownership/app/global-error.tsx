"use client";

import { globalErrorOnlyAction } from "./global-error-action";

export default function GlobalError() {
  return (
    <html>
      <body>
        <form action={globalErrorOnlyAction}>Global error action</form>
      </body>
    </html>
  );
}
