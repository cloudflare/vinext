export function withEnvVar<T>(
  name: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T>;
export function withEnvVar<T>(name: string, value: string | undefined, run: () => T): T;
export function withEnvVar<T>(
  name: string,
  value: string | undefined,
  run: () => T | Promise<T>,
): T | Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  const restore = () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };

  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
