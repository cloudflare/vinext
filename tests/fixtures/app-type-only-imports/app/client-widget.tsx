"use client";

// Mixed value + inline type specifiers: the value import must survive.
import { useState, type FC } from "react";
// Inline type-only specifier import of a server-only module. If elision
// leaves a side-effect `import "./server-data"` behind, the server module
// (and everything it imports) is pulled into the client bundle — the
// create-t3-app failure mode where the tRPC server router shipped to the
// browser.
import { type ServerData } from "./server-data";

const ClientWidget: FC = () => {
  const [data] = useState<ServerData | null>(null);
  return <p data-testid="client-widget">client widget {data ? data.secret : "empty"}</p>;
};

export default ClientWidget;
