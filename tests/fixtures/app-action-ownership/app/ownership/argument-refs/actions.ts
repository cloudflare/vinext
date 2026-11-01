"use server";

import { redirect } from "next/navigation";

function describe(value: unknown) {
  return typeof value === "function" ? "FUNCTION_ARGUMENT" : `VALUE_ARGUMENT:${typeof value}`;
}

async function describeFirstItem(value: unknown) {
  // Stream and iterable parts decode as they are read, so describe the first item.
  if (value instanceof ReadableStream) {
    const { value: item } = await value.getReader().read();
    return describe(item);
  }
  if (typeof value === "object" && value !== null && Symbol.asyncIterator in value) {
    for await (const item of value as AsyncIterable<unknown>) return describe(item);
  }
  return describe(value);
}

export async function describeArgument(value?: unknown) {
  return describeFirstItem(value);
}

export async function describeBoundArgument(value: unknown) {
  // Progressive submissions render the page, so report the bound argument in the URL.
  redirect(`/ownership/argument-refs?described=${await describeFirstItem(value)}`);
}
