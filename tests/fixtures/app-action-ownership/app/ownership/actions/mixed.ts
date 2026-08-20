"use server";

export async function mixedStaticAction() {
  return "MIXED_STATIC_OK";
}

export async function mixedDynamicAction() {
  return "MIXED_DYNAMIC_OK";
}
