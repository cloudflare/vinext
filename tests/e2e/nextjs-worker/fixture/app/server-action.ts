"use server";

const ACTION_BODY = "server-action-body";

export async function getActionBody() {
  return ACTION_BODY;
}

// Shares a name with the worker global the reference uses to report calls.
export async function reportError() {
  return ACTION_BODY;
}
