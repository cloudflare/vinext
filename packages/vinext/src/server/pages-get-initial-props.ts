type PagesGetInitialPropsContext = {
  req?: unknown;
  res?: unknown;
  err?: unknown;
  pathname: string;
  query: Record<string, unknown>;
  asPath: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
};

type PagesGetInitialProps = (context: PagesGetInitialPropsContext) => unknown;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPagesGetInitialProps(value: unknown): value is PagesGetInitialProps {
  return typeof value === "function";
}

function getObjectProperty(target: unknown, property: string): unknown {
  if (!isObjectLike(target)) return undefined;
  return Reflect.get(target, property);
}

function getDisplayName(component: unknown): string {
  const displayName = getObjectProperty(component, "displayName");
  if (typeof displayName === "string" && displayName.length > 0) return displayName;

  const name = getObjectProperty(component, "name");
  if (typeof name === "string" && name.length > 0) return name;

  return "Component";
}

function getInitialPropsFn(component: unknown): PagesGetInitialProps | null {
  const getInitialProps = getObjectProperty(component, "getInitialProps");
  return isPagesGetInitialProps(getInitialProps) ? getInitialProps : null;
}

export function hasPagesGetInitialProps(component: unknown): boolean {
  return getInitialPropsFn(component) !== null;
}

export function isResponseSent(res: unknown): boolean {
  return (
    getObjectProperty(res, "headersSent") === true ||
    getObjectProperty(res, "writableEnded") === true
  );
}

function isPropsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeInitialPropsValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol")
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  if (typeof value === "function") return `[function ${getDisplayName(value)}]`;
  return Object.prototype.toString.call(value);
}

export async function loadPagesGetInitialProps(
  component: unknown,
  context: PagesGetInitialPropsContext,
): Promise<Record<string, unknown> | null> {
  const getInitialProps = getInitialPropsFn(component);
  if (!getInitialProps) return null;

  const result = await Promise.resolve(getInitialProps.call(component, context));
  if (isResponseSent(context.res)) {
    return isPropsObject(result) ? result : {};
  }

  if (!isPropsObject(result)) {
    throw new Error(
      `"${getDisplayName(
        component,
      )}.getInitialProps()" should resolve to an object. But found "${describeInitialPropsValue(
        result,
      )}" instead.`,
    );
  }

  return result;
}
