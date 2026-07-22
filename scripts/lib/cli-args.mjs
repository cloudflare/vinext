export function parseFlag(args, name) {
  const flag = args.find((arg) => arg.startsWith(`${name}=`));
  return flag ? flag.split("=").slice(1).join("=") : null;
}

export function intFlag(args, name, fallback) {
  const raw = parseFlag(args, name);
  if (raw === null) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}
