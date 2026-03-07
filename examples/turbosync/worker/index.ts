import handler from "vinext/server/app-router-entry";
import type {
  CreateRoomRequest,
  ApiErrorResponse,
  RoomExistsResponse,
} from "@/types";

// Re-export the Durable Object class so wrangler can discover it
export { Room } from "@/lib/room";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── WebSocket upgrade: GET /ws/:roomId ───────────────────────
    if (path.startsWith("/ws/")) {
      const roomId = path.slice(4);
      if (!roomId) {
        return jsonResponse<ApiErrorResponse>(
          { error: "Room ID is required in path: /ws/:roomId" },
          400,
        );
      }

      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return jsonResponse<ApiErrorResponse>(
          { error: "Expected WebSocket upgrade" },
          426,
        );
      }

      // Validate room exists before proxying
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      const exists = await stub.exists();
      if (!exists) {
        return jsonResponse<ApiErrorResponse>({ error: "Room not found" }, 404);
      }

      return stub.fetch(request);
    }

    // ─── REST API: /api/room/* ────────────────────────────────────
    if (path.startsWith("/api/room")) {
      return handleRoomApi(request, env, path);
    }

    // ─── Everything else → vinext (Next.js) ───────────────────────
    return handler.fetch(request);
  },
};

// ═══════════════════════════════════════════════════════════════════
//  REST API router
// ═══════════════════════════════════════════════════════════════════

async function handleRoomApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  // POST /api/room/create
  if (path === "/api/room/create" && request.method === "POST") {
    let body: CreateRoomRequest;
    try {
      body = (await request.json()) as CreateRoomRequest;
    } catch {
      return jsonResponse<ApiErrorResponse>(
        { error: "Invalid JSON body" },
        400,
      );
    }

    if (!body.name || typeof body.name !== "string") {
      return jsonResponse<ApiErrorResponse>(
        { error: '"name" is required' },
        400,
      );
    }

    const slug = toSlug(body.name);
    const stub = env.ROOM.get(env.ROOM.idFromName(slug));
    const result = await stub.createRoom(
      body.name,
      body.password,
      body.hostPeerId,
    );

    // Room name is already taken by another host
    if ("conflict" in result && result.conflict) {
      return jsonResponse<ApiErrorResponse>(
        {
          error: `A room named "${body.name}" already exists. Choose a different name.`,
        },
        409,
      );
    }

    return jsonResponse({ ...result, slug }, 200);
  }

  // GET /api/room/:roomId/exists
  const existsMatch = path.match(/^\/api\/room\/([^/]+)\/exists$/);
  if (existsMatch && request.method === "GET") {
    const roomId = existsMatch[1];
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const exists = await stub.exists();
    return jsonResponse<RoomExistsResponse>({ exists }, 200);
  }

  // GET /api/room/:roomId
  const match = path.match(/^\/api\/room\/([^/]+)$/);
  if (match && request.method === "GET") {
    const roomId = match[1];
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const exists = await stub.exists();
    if (!exists) {
      return jsonResponse<ApiErrorResponse>({ error: "Room not found" }, 404);
    }
    const result = await stub.getRoomState();
    return jsonResponse(result, 200);
  }

  return jsonResponse<ApiErrorResponse>({ error: "Not found" }, 404);
}

// ─── Helpers ──────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function jsonResponse<T>(data: T, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
