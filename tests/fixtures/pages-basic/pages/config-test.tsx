import getConfig from "next/config";

export default function ConfigTestPage() {
  const { publicRuntimeConfig } = getConfig();
  const appName = (publicRuntimeConfig?.appName as string) ?? "default-app";
  return (
    <div>
      <h1>Config Test</h1>
      <p id="app-name">App: {appName}</p>
    </div>
  );
}
