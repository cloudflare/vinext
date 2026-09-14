declare module "cloudflare:workers" {
  export const tracing:
    | {
        enterSpan<T, A extends unknown[]>(
          name: string,
          callback: (
            span: {
              readonly isTraced: boolean;
              end(): void;
              recordException?(
                exception: string | { name: string; message: string; stack?: string },
              ): void;
              setAttribute(key: string, value: boolean | number | string): void;
            },
            ...args: A
          ) => T,
          ...args: A
        ): T;
      }
    | undefined;
}
