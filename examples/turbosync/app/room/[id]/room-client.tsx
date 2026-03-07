"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RoomProvider, useRoom } from "@/lib/room-context";
import { LobbyScreen } from "@/components/lobby-screen";
import { PlayerDashboard } from "@/components/player-dashboard";
import { toast } from "sonner";

export function RoomClient({ roomId }: { roomId: string }) {
  return (
    <RoomProvider>
      <RoomController roomId={roomId} />
    </RoomProvider>
  );
}

function RoomController({ roomId }: { roomId: string }) {
  const { isConnected, connect, roomState, error } = useRoom();
  const [hasJoined, setHasJoined] = useState(false);
  const [roomExists, setRoomExists] = useState<boolean | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Validate room exists on mount
  useEffect(() => {
    async function checkRoom() {
      try {
        const res = await fetch(`/api/room/${roomId}/exists`);
        const data = (await res.json()) as { exists: boolean };
        setRoomExists(data.exists);
        if (!data.exists) {
          toast.error("Room not found", {
            description: `The room "${roomId}" does not exist. Create it first.`,
          });
        }
      } catch {
        setRoomExists(false);
        toast.error("Failed to check room status");
      }
    }
    checkRoom();
  }, [roomId]);

  // Auto-join if credentials are in sessionStorage (from home page)
  useEffect(() => {
    if (roomExists === false || hasJoined) return;

    // Try localStorage first
    const stored = localStorage.getItem(`join:${roomId}`);
    if (stored) {
      try {
        const { displayName, password, isHost, peerId } = JSON.parse(stored);
        // We keep the credentials in localStorage for re-refreshes/reconnects
        connect(
          roomId,
          { displayName, isHost: isHost || false, peerId },
          password,
        );
        setHasJoined(true);
        return;
      } catch {
        // Invalid stored data, fall through
      }
    }

    // Fallback: try URL search params (legacy support)
    const displayName = searchParams.get("displayName");
    if (displayName) {
      const password = searchParams.get("password") || undefined;
      const isHost = searchParams.get("host") === "1";
      connect(roomId, { displayName, isHost }, password);
      setHasJoined(true);
      // Clean URL params without reloading
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [searchParams, roomId, connect, hasJoined, roomExists]);

  // Show errors as toasts, not fullscreen
  useEffect(() => {
    if (error) {
      toast.error("Connection Error", { description: error });
    }
  }, [error]);

  // Still loading room existence check
  if (roomExists === null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#FAFAFA] dark:bg-[#050505]">
        <div className="w-12 h-12 border-4 border-[#111111] dark:border-white border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-[#666666] dark:text-[#A1A1AA] font-medium tracking-wide">
          Checking room...
        </p>
      </div>
    );
  }

  // Room doesn't exist
  if (roomExists === false) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#FAFAFA] dark:bg-[#050505] p-4">
        <div className="w-full max-w-sm bg-white dark:bg-[#0A0A0A] rounded-2xl border border-[#EAEAEA] dark:border-[#1F1F23] p-8 text-center shadow-lg">
          <h2 className="text-lg font-bold text-[#111] dark:text-[#EDEDED] mb-2">
            Room Not Found
          </h2>
          <p className="text-sm text-[#666] dark:text-[#A1A1AA] mb-6">
            The room &ldquo;{roomId}&rdquo; doesn&apos;t exist yet. You can
            create it from the home page.
          </p>
          <button
            onClick={() => router.push("/")}
            className="px-6 py-2.5 bg-[#111] dark:bg-white text-white dark:text-black text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  // If we haven't initiated a join yet, show the Lobby
  if (!hasJoined) {
    return (
      <LobbyScreen
        roomName={roomId.replace(/-/g, " ").toUpperCase()}
        onJoin={(displayName, _avatar, password) => {
          // Save for future auto-joins
          const pid =
            localStorage.getItem("turbosync_peerid") || crypto.randomUUID();
          localStorage.setItem("turbosync_peerid", pid);
          localStorage.setItem("turbosync_name", displayName);
          localStorage.setItem(
            `join:${roomId}`,
            JSON.stringify({
              displayName,
              password,
              isHost: false,
              peerId: pid,
            }),
          );

          connect(
            roomId,
            { displayName, isHost: false, peerId: pid },
            password,
          );
          setHasJoined(true);
        }}
      />
    );
  }

  // Connecting state
  if (!isConnected && !roomState) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#FAFAFA] dark:bg-[#050505]">
        <div className="w-12 h-12 border-4 border-[#111111] dark:border-white border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-[#666666] dark:text-[#A1A1AA] font-medium tracking-wide">
          Connecting to room...
        </p>
        <button
          onClick={() => {
            setHasJoined(false);
          }}
          className="mt-6 text-xs text-blue-500 hover:text-blue-600 underline"
        >
          Cancel and Return
        </button>
      </div>
    );
  }

  return <PlayerDashboard />;
}
