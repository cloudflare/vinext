import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  ReactNode,
} from "react";
import type {
  User,
  RoomState,
  RoomPermissions,
  WSClientMessage,
  WSServerMessage,
} from "@/types";
import { toast } from "sonner";

interface RoomContextType {
  roomState: RoomState | null;
  currentUser: User | null;
  isConnected: boolean;
  latency: number;
  error: string | null;
  connect: (
    roomId: string,
    user: Omit<User, "id"> & { peerId?: string },
    password?: string,
  ) => void;
  disconnect: (clearParams?: boolean) => void;
  play: (currentTime: number) => void;
  pause: (currentTime: number) => void;
  seek: (currentTime: number) => void;
  sendMessage: (message: string) => void;
  setPlaybackRate: (rate: number) => void;
  syncRequest: () => void;
  kick: (userId: string) => void;
  updatePermissions: (perms: Partial<RoomPermissions>) => void;
  reportTimeUpdate: (currentTime: number) => void;
  latencyHistory: number[];
}

const RoomContext = createContext<RoomContextType | undefined>(undefined);

export function RoomProvider({ children }: { children: ReactNode }) {
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [latency, setLatency] = useState(0);
  const [latencyHistory, setLatencyHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectionParamsRef = useRef<{
    roomId: string;
    user: Omit<User, "id"> & { peerId?: string };
    password?: string;
  } | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pingStartRef = useRef<number>(0);
  const lastPongReceivedAtRef = useRef<number>(0);

  // Helper: Get or create persistent peerId
  const getPeerId = useCallback(() => {
    if (typeof window === "undefined") return "";
    let pid = localStorage.getItem("turbosync_peerid");
    if (!pid) {
      pid = crypto.randomUUID();
      localStorage.setItem("turbosync_peerid", pid);
    }
    return pid;
  }, []);

  const disconnect = useCallback((clearParams = true) => {
    if (wsRef.current) {
      // Remove handlers before closing to prevent unwanted reconnects during intentional disconnect
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }
    if (clearParams) {
      connectionParamsRef.current = null;
      reconnectAttemptsRef.current = 0;
      setRoomState(null);
      setCurrentUser(null);
      setError(null);
    }
    setIsConnected(false);
  }, []);

  const connect = useCallback(
    (
      roomId: string,
      user: Omit<User, "id"> & { peerId?: string },
      password?: string,
    ) => {
      // Save params for reconnection
      connectionParamsRef.current = { roomId, user, password };

      // Ensure peerId is present
      const joinUser = {
        ...user,
        peerId: user.peerId || getPeerId(),
      };

      disconnect(false); // Close existing but keep params

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/${roomId}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;

        const joinMessage: WSClientMessage = {
          type: "join",
          user: joinUser,
          password,
        };
        ws.send(JSON.stringify(joinMessage));

        // Start pinging for latency measurement
        lastPongReceivedAtRef.current = performance.now();
        pingIntervalRef.current = setInterval(() => {
          const now = performance.now();
          // If we haven't received a pong in over 5s, assume connection is dead
          if (now - lastPongReceivedAtRef.current > 5000) {
            console.warn("Pong timeout, force closing for reconnection...");
            if (wsRef.current) {
              wsRef.current.close(); // Triggers onclose and auto-reconnect
            }
            return;
          }
          pingStartRef.current = now;
          ws.send("ping");
        }, 2000);
      };

      ws.onmessage = (event) => {
        // Handle automatic pong
        if (typeof event.data === "string" && event.data === "pong") {
          const now = performance.now();
          lastPongReceivedAtRef.current = now;
          const currentLatency = Math.round(now - pingStartRef.current);
          setLatency(currentLatency);
          setLatencyHistory((prev) => {
            const newHistory = [...prev, currentLatency];
            return newHistory.length > 40
              ? newHistory.slice(newHistory.length - 40)
              : newHistory;
          });
          return;
        }

        try {
          const msg = JSON.parse(event.data) as WSServerMessage;

          switch (msg.type) {
            case "room-state": {
              setRoomState(msg.room);
              // Server tells us our userId — use it to find ourselves in the user list
              const myId = msg.yourUserId;
              const me = msg.room.users.find((u) => u.id === myId);
              if (me) {
                setCurrentUser(me);
              }
              break;
            }

            case "sync":
              setRoomState((prev) => {
                if (!prev) return msg.room;
                // Preserve 'away' users that aren't in the new snapshot
                const onlineIds = new Set(msg.room.users.map((u) => u.id));
                const awayUsers = prev.users.filter(
                  (u) => u.connectionStatus === "away" && !onlineIds.has(u.id),
                );
                return {
                  ...msg.room,
                  users: [...msg.room.users, ...awayUsers],
                };
              });
              break;

            case "user-joined":
              toast.success(`${msg.user.displayName} joined the room`);
              setRoomState((prev) =>
                prev
                  ? {
                      ...prev,
                      users: [
                        ...prev.users.filter((u) => u.id !== msg.user.id),
                        msg.user,
                      ],
                    }
                  : null,
              );
              break;

            case "user-left":
              setRoomState((prev) => {
                if (!prev) return null;
                const user = prev.users.find((u) => u.id === msg.userId);
                if (user && user.connectionStatus !== "away") {
                  toast.info(`${user.displayName} disconnected`);
                }
                return {
                  ...prev,
                  users: prev.users.map((u) =>
                    u.id === msg.userId
                      ? { ...u, connectionStatus: "away" as const }
                      : u,
                  ),
                };
              });
              break;

            case "play":
              setRoomState((prev) =>
                prev
                  ? { ...prev, paused: false, currentTime: msg.currentTime }
                  : null,
              );
              break;

            case "pause":
              setRoomState((prev) =>
                prev
                  ? { ...prev, paused: true, currentTime: msg.currentTime }
                  : null,
              );
              break;

            case "seek":
              setRoomState((prev) =>
                prev ? { ...prev, currentTime: msg.currentTime } : null,
              );
              break;

            case "playback-rate":
              setRoomState((prev) =>
                prev ? { ...prev, playbackRate: msg.rate } : null,
              );
              break;

            case "permissions-updated":
              setRoomState((prev) =>
                prev ? { ...prev, permissions: msg.permissions } : null,
              );
              break;

            case "user-time-update":
              setRoomState((prev) => {
                if (!prev) return null;
                return {
                  ...prev,
                  users: prev.users.map((u) =>
                    u.id === msg.userId
                      ? { ...u, videoTimestamp: msg.currentTime }
                      : u,
                  ),
                };
              });
              break;

            case "kicked":
              setError(msg.reason);
              disconnect(true); // Intentional kick = stop reconnecting
              break;

            case "chat":
              console.log(`Chat from ${msg.displayName}: ${msg.message}`);
              break;

            case "error":
              console.error("Room error:", msg.message);
              // Only stop reconnecting if it's an auth/not-found error
              if (msg.code === "UNAUTHORIZED" || msg.code === "NOT_FOUND") {
                setError(msg.message);
                disconnect(true);
              } else {
                setError(msg.message);
              }
              break;
          }
        } catch (err) {
          console.error("Failed to parse websocket message", err);
        }
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);

        // Attempt reconnection if not closed intentionally
        if (event.code !== 1000 && connectionParamsRef.current) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            10000,
          );
          reconnectAttemptsRef.current += 1;
          setError(
            `Connection lost. Retrying in ${Math.round(delay / 1000)}s...`,
          );

          reconnectTimeoutRef.current = setTimeout(() => {
            const params = connectionParamsRef.current;
            if (params) {
              connect(params.roomId, params.user, params.password);
            }
          }, delay);
        }
      };

      ws.onerror = () => {
        setIsConnected(false);
        // Error handler mostly triggers before close, let onclose handle the retry logic
      };
    },
    [disconnect, getPeerId],
  );

  const sendWS = useCallback((msg: WSClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const play = useCallback(
    (currentTime: number) => {
      sendWS({ type: "play", currentTime });
      setRoomState((prev) =>
        prev ? { ...prev, paused: false, currentTime } : null,
      );
    },
    [sendWS],
  );

  const pause = useCallback(
    (currentTime: number) => {
      sendWS({ type: "pause", currentTime });
      setRoomState((prev) =>
        prev ? { ...prev, paused: true, currentTime } : null,
      );
    },
    [sendWS],
  );

  const seek = useCallback(
    (currentTime: number) => {
      sendWS({ type: "seek", currentTime });
      setRoomState((prev) => (prev ? { ...prev, currentTime } : null));
    },
    [sendWS],
  );

  const sendMessage = useCallback(
    (message: string) => {
      sendWS({ type: "chat", message });
    },
    [sendWS],
  );

  const setPlaybackRate = useCallback(
    (rate: number) => {
      sendWS({ type: "playback-rate", rate });
    },
    [sendWS],
  );

  const syncRequest = useCallback(() => {
    sendWS({ type: "sync-request" });
  }, [sendWS]);

  const kick = useCallback(
    (userId: string) => {
      sendWS({ type: "kick", userId });
    },
    [sendWS],
  );

  const updatePermissions = useCallback(
    (perms: Partial<RoomPermissions>) => {
      sendWS({ type: "update-permissions", permissions: perms });
    },
    [sendWS],
  );

  const reportTimeUpdate = useCallback(
    (currentTime: number) => {
      sendWS({ type: "time-update", currentTime });
    },
    [sendWS],
  );

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return (
    <RoomContext.Provider
      value={{
        roomState,
        currentUser,
        isConnected,
        latency,
        latencyHistory,
        error,
        connect,
        disconnect,
        play,
        pause,
        seek,
        sendMessage,
        setPlaybackRate,
        syncRequest,
        kick,
        updatePermissions,
        reportTimeUpdate,
      }}
    >
      {children}
    </RoomContext.Provider>
  );
}

export function useRoom() {
  const context = useContext(RoomContext);
  if (context === undefined) {
    throw new Error("useRoom must be used within a RoomProvider");
  }
  return context;
}
