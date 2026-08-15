import { createContext, useContext, useEffect, useState } from "react";

type ClientEnvValue = {
  isEmbedded: boolean;
  settled: boolean;
};

const ClientEnvContext = createContext<ClientEnvValue>({
  isEmbedded: false,
  settled: false,
});

export const ClientEnvProvider = ({
  isEmbedded,
  children,
}: {
  isEmbedded: boolean;
  children: React.ReactNode;
}) => {
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);

  return (
    <ClientEnvContext.Provider value={{ isEmbedded, settled }}>
      {children}
    </ClientEnvContext.Provider>
  );
};

export const useClientEnv = () => useContext(ClientEnvContext);
