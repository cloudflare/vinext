// Awaits at the top level on the server.
if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export const label = "undeclared";
