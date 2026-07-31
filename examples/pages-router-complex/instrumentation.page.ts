export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    (await import("./boot-state")).markBootHookCalled();
  }
};
