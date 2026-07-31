declare module "@next/env" {
  export type Env = Record<string, string | undefined>;
  export type LoadedEnvFiles = Array<{
    path: string;
    contents: string;
    env: Env;
  }>;
}

declare module "sharp" {
  const sharp: unknown;
  export default sharp;
}

// This must remain an interface so it can merge with TypeScript's built-in
// declaration when consumers include a newer ES lib.
// oxlint-disable-next-line typescript/consistent-type-definitions
interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  // Match the built-in lib declaration exactly so global merging succeeds.
  // oxlint-disable-next-line typescript/no-explicit-any
  reject: (reason?: any) => void;
}
