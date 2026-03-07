"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Video, Plus, LogIn } from "lucide-react";
import { toast } from "sonner";

export default function RoomHome() {
  const router = useRouter();
  const [tab, setTab] = useState<"create" | "join">("create");

  // Create room state
  const [createDisplayName, setCreateDisplayName] = useState(
    () =>
      (typeof window !== "undefined"
        ? localStorage.getItem("turbosync_name")
        : "") || "",
  );
  const [roomName, setRoomName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Join room state
  const [joinDisplayName, setJoinDisplayName] = useState(
    () =>
      (typeof window !== "undefined"
        ? localStorage.getItem("turbosync_name")
        : "") || "",
  );
  const [joinRoomName, setJoinRoomName] = useState("");
  const [joinPassword, setJoinPassword] = useState("");

  const slug = (name: string) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomName.trim() || !createDisplayName.trim()) return;

    setLoading(true);
    try {
      // Save displayName for next time
      localStorage.setItem("turbosync_name", createDisplayName.trim());

      // Get or create persistent peerId
      let hostPeerId = localStorage.getItem("turbosync_peerid");
      if (!hostPeerId) {
        hostPeerId = crypto.randomUUID();
        localStorage.setItem("turbosync_peerid", hostPeerId);
      }

      const res = await fetch("/api/room/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roomName.trim(),
          password: password.trim() || undefined,
          hostPeerId,
        }),
      });

      if (res.status === 409) {
        const data = (await res.json()) as { error: string };
        toast.error("Room name already taken", {
          description: data.error,
        });
        return;
      }

      if (!res.ok) throw new Error("Failed to create room");

      const data = (await res.json()) as { slug: string };

      // Store credentials in localStorage
      localStorage.setItem(
        `join:${data.slug}`,
        JSON.stringify({
          displayName: createDisplayName.trim(),
          password: password.trim() || undefined,
          isHost: true,
          peerId: hostPeerId,
        }),
      );

      router.push(`/room/${data.slug}`);
    } catch (err) {
      console.error(err);
      toast.error("Failed to create room", {
        description: "Please try again.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinRoomName.trim() || !joinDisplayName.trim()) return;

    const roomSlug = slug(joinRoomName);

    // Validate room exists before navigating
    try {
      const res = await fetch(`/api/room/${roomSlug}/exists`);
      const data = (await res.json()) as { exists: boolean };
      if (!data.exists) {
        toast.error("Room not found", {
          description: `"${joinRoomName}" doesn't exist. Check the name or create a new room.`,
        });
        return;
      }
    } catch {
      toast.error("Failed to check room", {
        description: "Network error. Please try again.",
      });
      return;
    }

    // Save displayName for next time
    localStorage.setItem("turbosync_name", joinDisplayName.trim());

    // Get or create persistent peerId
    let peerId = localStorage.getItem("turbosync_peerid");
    if (!peerId) {
      peerId = crypto.randomUUID();
      localStorage.setItem("turbosync_peerid", peerId);
    }

    // Store credentials in localStorage
    localStorage.setItem(
      `join:${roomSlug}`,
      JSON.stringify({
        displayName: joinDisplayName.trim(),
        password: joinPassword.trim() || undefined,
        isHost: false,
        peerId,
      }),
    );

    router.push(`/room/${roomSlug}`);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAFA] dark:bg-[#050505] p-4">
      <div className="w-full max-w-md bg-white dark:bg-[#0A0A0A] rounded-2xl shadow-xl border border-[#EAEAEA] dark:border-[#1F1F23] overflow-hidden">
        {/* Header */}
        <div className="flex flex-col items-center pt-8 pb-4 px-8">
          <div className="w-14 h-14 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center mb-3">
            <Video size={28} />
          </div>
          <h1 className="text-2xl font-bold text-[#111111] dark:text-[#EDEDED]">
            TurboSync
          </h1>
          <p className="text-sm text-[#666666] dark:text-[#A1A1AA] mt-1 text-center">
            Synchronized video playback rooms
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex mx-8 mt-2 mb-6 rounded-lg bg-gray-100 dark:bg-[#111111] p-1 border border-[#EAEAEA] dark:border-[#1F1F23]">
          <button
            onClick={() => setTab("create")}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-semibold rounded-md transition-all ${tab === "create" ? "bg-white dark:bg-[#0A0A0A] text-[#111111] dark:text-white shadow-sm" : "text-[#888] dark:text-[#666] hover:text-[#555] dark:hover:text-[#999]"}`}
          >
            <Plus size={16} /> Create Room
          </button>
          <button
            onClick={() => setTab("join")}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-semibold rounded-md transition-all ${tab === "join" ? "bg-white dark:bg-[#0A0A0A] text-[#111111] dark:text-white shadow-sm" : "text-[#888] dark:text-[#666] hover:text-[#555] dark:hover:text-[#999]"}`}
          >
            <LogIn size={16} /> Join Room
          </button>
        </div>

        {/* Create Room Form */}
        {tab === "create" && (
          <form onSubmit={handleCreateRoom} className="px-8 pb-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="createDisplayName">Display Name</Label>
              <Input
                id="createDisplayName"
                placeholder="What should we call you?"
                value={createDisplayName}
                onChange={(e) => setCreateDisplayName(e.target.value)}
                required
                className="bg-gray-50 dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                This is how other viewers will see you in the room.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="roomName">Room Name</Label>
              <Input
                id="roomName"
                placeholder="e.g. friday-movie-night"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                required
                className="bg-gray-50 dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                URL: /room/{slug(roomName) || "..."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password (optional)</Label>
              <Input
                id="password"
                type="password"
                autoFocus={false}
                autoComplete="off"
                placeholder="Leave blank for a public room"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-gray-50 dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                If set, viewers must enter this password to join.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full h-11 mt-2 bg-[#111111] hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200"
              disabled={
                !roomName.trim() || !createDisplayName.trim() || loading
              }
            >
              {loading ? "Creating..." : "Create & Enter Room"}
            </Button>
          </form>
        )}

        {/* Join Room Form */}
        {tab === "join" && (
          <form onSubmit={handleJoinRoom} className="px-8 pb-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="joinDisplayName">Display Name</Label>
              <Input
                id="joinDisplayName"
                placeholder="What should we call you?"
                value={joinDisplayName}
                onChange={(e) => setJoinDisplayName(e.target.value)}
                required
                className="bg-gray-50 dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                Your name as shown to the host and other viewers.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="joinRoom">Room Name</Label>
              <Input
                id="joinRoom"
                placeholder="e.g. friday-movie-night"
                value={joinRoomName}
                onChange={(e) => setJoinRoomName(e.target.value)}
                required
                className="bg-gray-50 dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                Enter the exact room name shared by the host.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="joinPassword">Room Password</Label>
              <Input
                id="joinPassword"
                type="password"
                autoFocus={false}
                autoComplete="off"
                placeholder="Leave blank if the room is public"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                className="bg-gray-50 dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                Required only if the host set a password.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full h-11 mt-2 bg-[#111111] hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200"
              disabled={!joinRoomName.trim() || !joinDisplayName.trim()}
            >
              Join Room
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
