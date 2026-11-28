import { useEffect, useState } from "react";

/** True once the component has hydrated, so specs can tell SSR from client. */
export const useHydrated = (): boolean => {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
};
