type PluginEnvironment = {
  name: string;
  config: {
    consumer?: string;
  };
};

/** Whether a Vite environment produces server-consumed output. */
export function isServerEnvironment(environment: PluginEnvironment): boolean {
  return environment.name !== "client" && environment.config.consumer !== "client";
}
