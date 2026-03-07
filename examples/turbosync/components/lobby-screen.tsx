"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Play } from "lucide-react";

interface LobbyScreenProps {
  onJoin: (displayName: string, avatar: string, password?: string) => void;
  roomName: string;
}

export function LobbyScreen({ onJoin, roomName }: LobbyScreenProps) {
  const [displayName, setDisplayName] = useState(
    () =>
      (typeof window !== "undefined"
        ? localStorage.getItem("turbosync_name")
        : "") || "",
  );
  const [password, setPassword] = useState("");

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    onJoin(displayName, "", password);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#FAFAFA] dark:bg-[#050505]">
      <div className="w-full max-w-105 bg-white dark:bg-[#0A0A0A] rounded-2xl shadow-[0_4px_12px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.02)] border border-[#EAEAEA] dark:border-[#1F1F23] overflow-hidden">
        {/* Header / Media Area */}
        <div className="relative w-full aspect-video bg-black group cursor-default">
          <div className="absolute inset-0 bg-linear-to-br from-[#111] to-[#333] flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30">
              <Play className="text-white fill-current w-6 h-6 ml-1" />
            </div>
          </div>

          <div className="absolute top-4 left-4">
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/50 backdrop-blur-md border border-white/10 text-[10px] font-semibold text-white uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
              Live
            </span>
          </div>
        </div>

        {/* Content Area */}
        <div className="p-8">
          <div className="mb-6 text-center">
            <h2 className="text-xl font-bold tracking-tight text-[#111111] dark:text-[#EDEDED] mb-1">
              {roomName || "Sync Room"}
            </h2>
            <p className="text-sm text-[#666666] dark:text-[#A1A1AA] font-medium">
              Join the session
            </p>
          </div>

          <form onSubmit={handleJoinRoom} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                placeholder="What should we call you?"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="bg-white dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                Your name as shown in the room.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Room Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Leave blank if the room is public"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-white dark:bg-[#111111] border-[#EAEAEA] dark:border-[#1F1F23]"
              />
              <p className="text-[11px] text-[#999] dark:text-[#555]">
                Required only if the host set a password.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full h-10 bg-black hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-200 text-white dark:text-black font-semibold shadow-[0_2px_4px_rgba(0,0,0,0.05)] mt-4"
              disabled={!displayName.trim()}
            >
              Enter Room
            </Button>
          </form>

          <div className="mt-8 flex items-center justify-center gap-2 text-xs text-[#888888] dark:text-[#6B7280]">
            <Lock size={14} />
            <span>Secure connection</span>
          </div>
        </div>
      </div>
    </div>
  );
}
