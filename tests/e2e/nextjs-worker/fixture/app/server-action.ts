"use server";

const ACTION_BODY = "server-action-body";

export async function getActionBody() {
  return ACTION_BODY;
}

// These share names with globals and bindings the worker references use; they
// must not shadow or redeclare them.
export async function reportError() {
  return ACTION_BODY;
}

export async function globalThis() {
  return ACTION_BODY;
}

export async function $$vinextWorkerReference() {
  return ACTION_BODY;
}

export async function $$ReactClient() {
  return ACTION_BODY;
}
