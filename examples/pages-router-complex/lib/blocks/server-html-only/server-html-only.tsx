import { useEffect, useState } from "react";

/**
 * Renders its children into the server HTML only: after hydration the
 * subtree is dropped. Used for crawler-facing markup that must never ship
 * interactive JavaScript.
 */
export const ServerHtmlOnly = ({ children }: { children: React.ReactNode }) => {
  const [pastHydration, setPastHydration] = useState(false);

  useEffect(() => {
    setPastHydration(true);
  }, []);

  if (pastHydration) {
    return null;
  }

  return <div suppressHydrationWarning>{children}</div>;
};
