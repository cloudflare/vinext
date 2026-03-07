import type {
  User,
  RoomState,
  RoomPermissions,
  WSClientMessage,
  WSServerMessage,
  CreateRoomResponse,
  RoomStateResponse,
} from "@/types";
import { DurableObject } from "cloudflare:workers";

// ─── Session attachment (serialized onto each WebSocket) ───────────
interface SessionAttachment {
  userId: string;
  peerId: string;
  displayName: string;
  avatar?: string;
  isHost: boolean;
  /** User's last reported local video timestamp */
  videoTimestamp?: number;
}

// ─── Default permissions ───────────────────────────────────────────
const DEFAULT_PERMISSIONS: RoomPermissions = {
  viewersCanControl: true,
  viewersCanChat: true,
};

// ─── Room Durable Object ───────────────────────────────────────────
export class Room extends DurableObject<Env> {
  private sessions: Map<WebSocket, SessionAttachment>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Rebuild sessions from any hibernated WebSockets
    this.sessions = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (attachment) {
        this.sessions.set(ws, { ...attachment });
      }
    }

    // Automatic ping/pong that doesn't wake the DO from hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  // ─── RPC: Check if room exists ──────────────────────────────────
  async exists(): Promise<boolean> {
    const name = await this.ctx.storage.get<string>("name");
    return name !== undefined;
  }

  // ─── RPC: Create / initialize room metadata ─────────────────────
  async createRoom(
    name: string,
    password?: string,
    hostPeerId?: string,
  ): Promise<CreateRoomResponse | { conflict: true }> {
    const existingName = await this.ctx.storage.get<string>("name");
    const existingHostPeerId = await this.ctx.storage.get<string>("hostPeerId");

    // If the room is already claimed (has a stored hostPeerId), reject it
    if (existingName && existingHostPeerId) {
      return { conflict: true };
    }

    const initialData: Record<string, any> = {
      name,
      paused: true,
      currentTime: 0,
      playbackRate: 1,
    };

    if (password) {
      initialData.password = password;
    } else {
      await this.ctx.storage.delete("password");
    }

    // Set default permissions
    initialData.permissions = DEFAULT_PERMISSIONS;

    if (hostPeerId) {
      initialData.hostPeerId = hostPeerId;
    }

    await this.ctx.storage.put(initialData);

    return { roomId: this.ctx.id.toString(), name };
  }

  // ─── RPC: Get room state ────────────────────────────────────────
  async getRoomState(): Promise<RoomStateResponse> {
    const room = await this.buildRoomSnapshot();
    return { room };
  }

  // ─── WebSocket upgrade via fetch() ──────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Reject if room doesn't exist
    const roomExists = await this.exists();
    if (!roomExists) {
      return new Response(JSON.stringify({ error: "Room not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);

    const userId = crypto.randomUUID();
    const attachment: SessionAttachment = {
      userId,
      peerId: "", // Will be set on Join
      displayName: "Anonymous",
      isHost: false, // Will be set on Join
    };
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WebSocket message handler ──────────────────────────────────
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let parsed: WSClientMessage;

    try {
      const raw =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      parsed = JSON.parse(raw) as WSClientMessage;
    } catch {
      this.send(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Could not parse message as JSON",
      });
      return;
    }

    const session = this.sessions.get(ws);
    if (!session) return;

    switch (parsed.type) {
      case "join":
        await this.handleJoin(ws, session, parsed);
        break;
      case "leave":
        await this.handleLeave(ws, session);
        break;
      case "play":
        await this.handlePlaybackAction(
          ws,
          session,
          "play",
          parsed.currentTime,
        );
        break;
      case "pause":
        await this.handlePlaybackAction(
          ws,
          session,
          "pause",
          parsed.currentTime,
        );
        break;
      case "seek":
        await this.handlePlaybackAction(
          ws,
          session,
          "seek",
          parsed.currentTime,
        );
        break;
      case "chat":
        await this.handleChat(ws, session, parsed.message);
        break;
      case "sync-request": {
        const roomState = await this.buildRoomSnapshot();
        this.send(ws, { type: "sync", room: roomState });
        break;
      }
      case "playback-rate":
        await this.ctx.storage.put("playbackRate", parsed.rate);
        this.broadcast({
          type: "playback-rate",
          rate: parsed.rate,
          userId: session.userId,
        });
        break;
      case "time-update":
        this.handleTimeUpdate(ws, session, parsed.currentTime);
        break;
      case "kick":
        await this.handleKick(ws, session, parsed.userId);
        break;
      case "update-permissions":
        await this.handleUpdatePermissions(ws, session, parsed.permissions);
        break;
      default:
        this.send(ws, {
          type: "error",
          code: "UNKNOWN_TYPE",
          message: `Unknown message type: ${(parsed as { type: string }).type}`,
        });
    }
  }

  // ─── WebSocket close handler ────────────────────────────────────
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    try {
      ws.close(code, reason);
    } catch {
      // Socket may already be closed
    }

    if (session) {
      this.broadcast({ type: "user-left", userId: session.userId });
    }
  }

  // ─── WebSocket error handler ────────────────────────────────────
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (session) {
      this.broadcast({ type: "user-left", userId: session.userId });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════════════════════════════

  private async handleJoin(
    ws: WebSocket,
    session: SessionAttachment,
    msg: Extract<WSClientMessage, { type: "join" }>,
  ): Promise<void> {
    const expectedPassword = await this.ctx.storage.get<string>("password");
    if (expectedPassword && msg.password !== expectedPassword) {
      this.send(ws, {
        type: "error",
        code: "UNAUTHORIZED",
        message: "Invalid room password",
      });
      ws.close(1008, "Invalid room password");
      this.sessions.delete(ws);
      return;
    }

    const hostPeerId = await this.ctx.storage.get<string>("hostPeerId");
    const hasActiveHost = Array.from(this.sessions.values()).some(
      (s) => s.isHost && s.peerId !== msg.user.peerId,
    );

    let isHost = msg.user.isHost;

    if (hostPeerId) {
      // If a hostPeerId exists, only a matching peerId can be host
      if (msg.user.peerId === hostPeerId) {
        isHost = true;
      } else {
        isHost = false;
      }
    } else if (isHost) {
      // If no hostPeerId exists yet, the first person who claims to be host sets it
      await this.ctx.storage.put("hostPeerId", msg.user.peerId);
    }

    // Double check: if there's already an active host (different peer), demote this one
    if (isHost && hasActiveHost) {
      isHost = false;
    }

    // Generate userId from slugified displayName
    const slugId = msg.user.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const newUserId = slugId || session.userId; // fallback to generated UUID if name is empty

    // Deduplicate: If another session has the same userId, disconnect it
    for (const [existingWs, existingSession] of this.sessions.entries()) {
      if (existingSession.userId === newUserId && existingWs !== ws) {
        this.sessions.delete(existingWs);
        try {
          existingWs.close(1008, "Joined from another device");
        } catch {}
      }
    }

    // Update session with real user info
    session.userId = newUserId;
    session.displayName = msg.user.displayName;
    session.peerId = msg.user.peerId;
    session.avatar = msg.user.avatar;
    session.isHost = isHost;
    ws.serializeAttachment(session);
    this.sessions.set(ws, session);

    const user = this.sessionToUser(session);

    // Broadcast to everyone else
    this.broadcast({ type: "user-joined", user }, ws);

    // Send current room state to the joining user, including their server-assigned ID
    const roomState = await this.buildRoomSnapshot();
    this.send(ws, {
      type: "room-state",
      room: roomState,
      yourUserId: session.userId,
    });
  }

  private async handleLeave(
    ws: WebSocket,
    session: SessionAttachment,
  ): Promise<void> {
    this.sessions.delete(ws);
    this.broadcast({ type: "user-left", userId: session.userId });
    ws.close(1000, "User left");
  }

  /** Unified playback action handler with permission enforcement */
  private async handlePlaybackAction(
    ws: WebSocket,
    session: SessionAttachment,
    action: "play" | "pause" | "seek",
    currentTime: number,
  ): Promise<void> {
    // Check permissions: only enforce if viewersCanControl is explicitly false
    if (!session.isHost) {
      const permissions = await this.getPermissions();
      if (!permissions.viewersCanControl) {
        this.send(ws, {
          type: "error",
          code: "PERMISSION_DENIED",
          message: "You don't have permission to control playback",
        });
        return;
      }
    }

    switch (action) {
      case "play":
        await this.ctx.storage.put({ paused: false, currentTime });
        this.broadcast(
          { type: "play", currentTime, userId: session.userId },
          ws,
        );
        break;
      case "pause":
        await this.ctx.storage.put({ paused: true, currentTime });
        this.broadcast(
          { type: "pause", currentTime, userId: session.userId },
          ws,
        );
        break;
      case "seek":
        await this.ctx.storage.put("currentTime", currentTime);
        this.broadcast(
          { type: "seek", currentTime, userId: session.userId },
          ws,
        );
        break;
    }
  }

  private async handleChat(
    ws: WebSocket,
    session: SessionAttachment,
    message: string,
  ): Promise<void> {
    if (!session.isHost) {
      const permissions = await this.getPermissions();
      if (!permissions.viewersCanChat) {
        this.send(ws, {
          type: "error",
          code: "PERMISSION_DENIED",
          message: "Chat is disabled by the host",
        });
        return;
      }
    }

    this.broadcast({
      type: "chat",
      message,
      userId: session.userId,
      displayName: session.displayName,
    });
  }

  private handleTimeUpdate(
    ws: WebSocket,
    session: SessionAttachment,
    currentTime: number,
  ): void {
    // Update session's video timestamp
    session.videoTimestamp = currentTime;
    ws.serializeAttachment(session);
    this.sessions.set(ws, session);

    // Broadcast to all other clients
    this.broadcast(
      {
        type: "user-time-update",
        userId: session.userId,
        currentTime,
      },
      ws,
    );
  }

  private async handleKick(
    ws: WebSocket,
    session: SessionAttachment,
    targetUserId: string,
  ): Promise<void> {
    // Only host can kick
    if (!session.isHost) {
      this.send(ws, {
        type: "error",
        code: "PERMISSION_DENIED",
        message: "Only the host can kick users",
      });
      return;
    }

    // Find and disconnect the target user
    for (const [targetWs, targetSession] of this.sessions) {
      if (targetSession.userId === targetUserId) {
        this.send(targetWs, {
          type: "kicked",
          reason: "You have been kicked by the host",
        });
        targetWs.close(1000, "Kicked by host");
        this.sessions.delete(targetWs);
        this.broadcast({ type: "user-left", userId: targetUserId });
        return;
      }
    }
  }

  private async handleUpdatePermissions(
    ws: WebSocket,
    session: SessionAttachment,
    newPerms: Partial<RoomPermissions>,
  ): Promise<void> {
    if (!session.isHost) {
      this.send(ws, {
        type: "error",
        code: "PERMISSION_DENIED",
        message: "Only the host can update permissions",
      });
      return;
    }

    const current = await this.getPermissions();
    const merged: RoomPermissions = { ...current, ...newPerms };
    await this.ctx.storage.put("permissions", merged);

    this.broadcast({ type: "permissions-updated", permissions: merged });
  }

  private async getPermissions(): Promise<RoomPermissions> {
    const stored = await this.ctx.storage.get<RoomPermissions>("permissions");
    return stored ?? DEFAULT_PERMISSIONS;
  }

  /** Send a typed message to a single WebSocket */
  private send(ws: WebSocket, message: WSServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket may already be closed — ignore
    }
  }

  /** Broadcast a typed message to all connected clients, optionally excluding one */
  private broadcast(message: WSServerMessage, exclude?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const [ws] of this.sessions) {
      if (ws === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // Dead socket — will be cleaned up on next close/error
      }
    }
  }

  /** Build a Room snapshot from storage + active sessions */
  private async buildRoomSnapshot(): Promise<RoomState> {
    const [name, paused, currentTime, playbackRate, permissions] =
      await Promise.all([
        this.ctx.storage.get<string>("name"),
        this.ctx.storage.get<boolean>("paused"),
        this.ctx.storage.get<number>("currentTime"),
        this.ctx.storage.get<number>("playbackRate"),
        this.getPermissions(),
      ]);

    const users: User[] = [];
    for (const [, session] of this.sessions) {
      users.push(this.sessionToUser(session));
    }

    return {
      id: this.ctx.id.toString(),
      name: name ?? "Unnamed Room",
      users,
      currentTime: currentTime ?? 0,
      paused: paused ?? true,
      playbackRate: playbackRate ?? 1,
      permissions,
    };
  }

  /** Convert a session attachment to a User */
  private sessionToUser(session: SessionAttachment): User {
    return {
      id: session.userId,
      peerId: session.peerId,
      displayName: session.displayName,
      avatar: session.avatar,
      isHost: session.isHost,
      connectionStatus: "online",
      videoTimestamp: session.videoTimestamp,
    };
  }
}
