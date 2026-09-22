export async function register(): Promise<void> {
  const { initialize } = await import("./instrumentation-server");
  initialize();
}
