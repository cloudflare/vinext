const SERVER_ACTION_NOT_FOUND_DOCS =
  "https://nextjs.org/docs/messages/failed-to-find-server-action";

const SERVER_ACTION_NOT_FOUND_HEADER = "x-nextjs-action-not-found";
const SERVER_ACTION_NOT_FOUND_BODY = "Server action not found.";

function getServerActionNotFoundPrefix(actionId: string | null): string {
  return `Failed to find Server Action${actionId ? ` "${actionId}"` : ""}.`;
}

export function getServerActionNotFoundMessage(actionId: string | null): string {
  return `${getServerActionNotFoundPrefix(
    actionId,
  )} This request might be from an older or newer deployment.\nRead more: ${SERVER_ACTION_NOT_FOUND_DOCS}`;
}

export function getServerActionNotFoundClientMessage(actionId: string): string {
  return `Server Action "${actionId}" was not found on the server. \nRead more: ${SERVER_ACTION_NOT_FOUND_DOCS}`;
}

function getUnknownMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
}

export function isServerActionNotFoundError(error: unknown, actionId: string | null): boolean {
  const message = getUnknownMessage(error);
  if (!message) {
    return false;
  }

  if (!actionId) {
    return message.startsWith("Failed to find Server Action");
  }

  if (message.startsWith(getServerActionNotFoundPrefix(actionId))) {
    return true;
  }

  return Boolean(actionId && message.includes(`[vite-rsc] invalid server reference '${actionId}'`));
}

export function createServerActionNotFoundResponse(): Response {
  return new Response(SERVER_ACTION_NOT_FOUND_BODY, {
    status: 404,
    headers: {
      [SERVER_ACTION_NOT_FOUND_HEADER]: "1",
      "content-type": "text/plain",
    },
  });
}

export function isServerActionNotFoundResponse(response: Pick<Response, "headers">): boolean {
  return response.headers.get(SERVER_ACTION_NOT_FOUND_HEADER) === "1";
}
