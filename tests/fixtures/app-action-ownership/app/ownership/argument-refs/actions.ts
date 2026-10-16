"use server";

export async function describeArgument(value?: unknown) {
  return typeof value === "function" ? "FUNCTION_ARGUMENT" : `VALUE_ARGUMENT:${typeof value}`;
}
