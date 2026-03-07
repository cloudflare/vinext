"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRoom } from "@/lib/room-context";
import { PeerPermissionsDialog } from "@/components/peer-permissions-dialog";
import { RoomSettingsDialog } from "@/components/room-settings-dialog";
import {
  LocalVideoPlayer,
  type LocalVideoPlayerHandle,
} from "@/components/local-video-player";
import { Badge } from "@/components/ui/badge";
import {
  Sun,
  Moon,
  Play,
  Pause,
  Settings,
  Filter,
  Wifi,
  WifiOff,
  Clock,
  Volume2,
  VolumeOff,
  Maximize,
  SkipBack,
  SkipForward,
  Captions,
  CaptionsOff,
  Users,
  Video,
  MousePointerClick,
  Link,
  Crown,
  MonitorPlay,
  Activity,
} from "lucide-react";

import { type User } from "@/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTimestamp(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  ActiveMembersTable                                                 */
/* ------------------------------------------------------------------ */

function ActiveMembersTable({
  activeUsers,
  currentUser,
  latency,
  isConnected,
  roomState,
}: {
  activeUsers: User[];
  currentUser: User | null;
  latency: number;
  isConnected: boolean;
  roomState: any; // Assuming roomState is passed down
}) {
  return (
    <div className="bg-[#FFFFFF] dark:bg-[#0A0A0A] border border-[#E5E7EB] dark:border-[#1F1F23] rounded-xl shadow-sm overflow-hidden flex flex-col relative">
      <div className="px-5 py-4 border-b border-[#E5E7EB] dark:border-[#1F1F23] flex flex-wrap items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-bold text-[#111827] dark:text-[#EDEDED] uppercase tracking-wider">
            Active Members
          </h3>
          <span className="bg-gray-100 dark:bg-[#111111] text-[#6B7280] dark:text-[#A1A1AA] px-2 py-0.5 rounded text-[10px] font-bold border border-[#E5E7EB] dark:border-[#1F1F23]">
            {activeUsers.length} Online
          </span>
        </div>

        <div className="flex gap-2">
          <PeerPermissionsDialog>
            {currentUser?.isHost && (
              <button className="px-3 py-1.5 bg-white dark:bg-[#111111] border border-[#E5E7EB] dark:border-[#1F1F23] rounded text-[10px] font-bold text-[#6B7280] dark:text-[#A1A1AA] hover:border-gray-300 dark:hover:border-gray-600 transition-colors flex items-center gap-1.5 uppercase tracking-wide">
                <Filter size={14} />
                Manage
              </button>
            )}
          </PeerPermissionsDialog>
        </div>
      </div>

      <div className="overflow-y-auto scrollbar-hide flex-1">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="bg-gray-50/50 dark:bg-[#111111]/50 text-[10px] uppercase text-[#6B7280] dark:text-[#A1A1AA] font-bold tracking-widest border-b border-[#E5E7EB] dark:border-[#1F1F23] sticky top-0 z-10">
            <tr>
              <th className="px-5 py-3" scope="col">
                User
              </th>
              <th className="px-5 py-3" scope="col">
                Status
              </th>
              <th className="px-5 py-3" scope="col">
                Timeline Sync
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EAEAEA] dark:divide-[#1F1F23]">
            {activeUsers.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-5 py-8 text-center text-[#6B7280] dark:text-[#A1A1AA]"
                >
                  Waiting for peers to join...
                </td>
              </tr>
            ) : (
              roomState.users
                // Sort so we're always at the top
                .sort((a: User, b: User) => {
                  if (a.id === currentUser?.id) return -1;
                  if (b.id === currentUser?.id) return 1;
                  return 0;
                })
                .map((user: User) => {
                  const isMe = user.id === currentUser?.id;
                  const isOnline = user.connectionStatus === "online";

                  // For the current user, show the live data from context rather than the broadcasted state
                  const userPing = isMe
                    ? latency
                    : isOnline
                      ? Math.floor(Math.random() * 40) + 20
                      : 0; // Simplified ping display since we only have true latency for current user
                  const displayTime = isMe
                    ? roomState.currentTime
                    : user.videoTimestamp;

                  return (
                    <tr
                      key={user.id}
                      className="hover:bg-gray-50 dark:hover:bg-[#111111] transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-linear-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-[10px] font-black border border-white/20">
                            {user.displayName.substring(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-bold text-[#111827] dark:text-[#EDEDED] flex items-center gap-2">
                              {user.displayName}
                              {isMe && (
                                <Badge
                                  variant="outline"
                                  className="text-[8px] h-4 px-1 py-0 border-blue-500/30 text-blue-500"
                                >
                                  YOU
                                </Badge>
                              )}
                              {user.isHost && (
                                <Badge
                                  variant="outline"
                                  className="text-[8px] h-4 px-1 py-0 border-amber-500/30 text-amber-500"
                                >
                                  HOST
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA]">
                              {user.isHost ? "Host" : "Viewer"}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Connection Status */}
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          {isOnline ? (
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
                              <Activity size={12} />
                              <span className="text-xs font-semibold">
                                {userPing}ms
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                              <WifiOff size={12} />
                              <span className="text-xs font-semibold">
                                Offline
                              </span>
                            </div>
                          )}

                          {/* Mini Ping Chart (only realistic for current user, mocked for others to show UI) */}
                          {isOnline && (
                            <div className="flex items-end gap-0.5 h-4 opacity-70 ml-1">
                              {Array.from({ length: 5 }).map((_, i) => (
                                <div
                                  key={i}
                                  className={`w-1 rounded-t-sm ${isMe ? "bg-green-500" : "bg-gray-400 dark:bg-gray-600"}`}
                                  style={{
                                    height: `${isMe ? Math.max(20, Math.min(100, 100 - latency / 2 + Math.random() * 20)) : Math.random() * 60 + 40}%`,
                                    opacity: 0.5 + i * 0.1,
                                  }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Timeline Sync */}
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          {isOnline ? (
                            <div className="flex items-center gap-2">
                              {user.isHost && (
                                <Crown size={12} className="text-amber-500" />
                              )}
                              <div className="font-mono text-xs text-[#111111] dark:text-[#EDEDED] bg-gray-100 dark:bg-[#111111] px-2 py-1 rounded-md">
                                {formatTimestamp(displayTime || 0)}
                              </div>
                              {Math.abs(
                                (displayTime || 0) - roomState.currentTime,
                              ) > 2 && (
                                <span className="text-[10px] font-medium text-amber-500 flex items-center gap-1 bg-amber-500/10 px-1.5 py-0.5 rounded">
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                                  Syncing
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-[#999] opacity-50">
                              -
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DashboardHeader                                                    */
/* ------------------------------------------------------------------ */

function DashboardHeader({
  roomName,
  isDark,
  toggleDark,
  latency,
  isConnected,
}: {
  roomName: string;
  isDark: boolean;
  toggleDark: () => void;
  latency: number;
  isConnected: boolean;
}) {
  return (
    <header className="w-full h-14 flex items-center justify-between px-4 md:px-6 border-b border-[#E5E7EB] dark:border-[#1F1F23] bg-[#FFFFFF] dark:bg-[#0A0A0A] transition-colors duration-200 sticky top-0 z-50">
      <div className="flex items-center gap-2 md:gap-3">
        <div className="hidden sm:block w-4 h-4 bg-[#111111] dark:bg-white rounded-full"></div>
        <h1 className="text-xs md:text-sm font-bold tracking-tight uppercase truncate max-w-30 sm:max-w-50">
          {roomName || "Sync Room"}
        </h1>
        <span className="hidden sm:inline-flex bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest border border-green-200 dark:border-green-800">
          Live
        </span>
      </div>

      <div className="flex items-center gap-2 md:gap-4">
        <div className="flex items-center gap-1.5 md:gap-2 text-[10px] md:text-[11px] font-semibold text-[#6B7280] dark:text-[#A1A1AA] uppercase tracking-wider">
          <span
            className={`w-1.5 h-1.5 rounded-full ${isConnected ? (latency < 200 ? "bg-green-500" : "bg-amber-500") : "bg-red-500"} animate-pulse`}
          ></span>
          <span className="font-mono">
            {isConnected ? `${latency}ms` : "reconnecting..."}
          </span>
        </div>
        <div className="h-4 w-px bg-[#E5E7EB] dark:bg-[#1F1F23] mx-0.5 md:mx-1"></div>

        <button
          className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-[#1C1C1C] text-[#6B7280] dark:text-[#A1A1AA] transition-colors"
          onClick={toggleDark}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  PlayerDashboard (main export)                                      */
/* ------------------------------------------------------------------ */

export function PlayerDashboard() {
  const {
    roomState,
    currentUser,
    isConnected,
    latency,
    play,
    pause,
    seek,
    reportTimeUpdate,
  } = useRoom();
  const [isDark, setIsDark] = useState(true);
  const playerRef = useRef<LocalVideoPlayerHandle>(null);

  const [localProgress, setLocalProgress] = useState({
    current: 0,
    duration: 0,
    percent: 0,
  });
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [seekHover, setSeekHover] = useState<{
    pct: number;
    time: number;
  } | null>(null);
  const [subtitlesVisible, setSubtitlesVisible] = useState(true);
  const seekBarRef = useRef<HTMLDivElement>(null);

  // Toggle dark mode via the HTML class for Tailwind compatibility
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [isDark]);

  // Guard to prevent feedback loops when applying remote state
  const syncingRef = useRef(false);

  // Apply remote room state changes to local player
  useEffect(() => {
    if (!roomState || !playerRef.current) return;

    syncingRef.current = true;

    const localPaused = playerRef.current.isPaused();
    if (roomState.paused && !localPaused) {
      playerRef.current.pause();
    } else if (!roomState.paused && localPaused) {
      playerRef.current.play();
    }

    const internalTime = playerRef.current.getCurrentTime();
    const drift = Math.abs(internalTime - roomState.currentTime);
    if (drift > 0.5) {
      playerRef.current.seek(roomState.currentTime);
    }

    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  }, [roomState?.currentTime, roomState?.paused]);

  // Report local time to server every 3s
  useEffect(() => {
    const interval = setInterval(() => {
      if (playerRef.current) {
        reportTimeUpdate(playerRef.current.getCurrentTime());
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [reportTimeUpdate]);

  const activeUsers = roomState?.users || [];
  const hasVideo = localProgress.duration > 0;

  // Callbacks from LocalVideoPlayer → broadcast to room
  const onVideoPlay = useCallback(
    (currentTime: number) => {
      if (syncingRef.current) return;
      play(currentTime);
    },
    [play],
  );

  const onVideoPause = useCallback(
    (currentTime: number) => {
      if (syncingRef.current) return;
      pause(currentTime);
    },
    [pause],
  );

  const onVideoSeek = useCallback(
    (time: number) => {
      if (syncingRef.current) return;
      seek(time);
    },
    [seek],
  );

  // Custom control bar play/pause
  const handlePlayToggle = () => {
    if (!playerRef.current) return;
    const t = playerRef.current.getCurrentTime();
    if (playerRef.current.isPaused()) {
      play(t);
      playerRef.current.play();
    } else {
      pause(t);
      playerRef.current.pause();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F3F4F6] dark:bg-[#050505] text-[#111827] dark:text-[#EDEDED] antialiased transition-colors duration-200">
      <DashboardHeader
        roomName={roomState?.name || "Sync Room"}
        isDark={isDark}
        toggleDark={() => setIsDark(!isDark)}
        latency={latency}
        isConnected={isConnected}
      />

      <main className="flex-1 w-full max-w-350 mx-auto p-4 md:p-6 space-y-6">
        {/* Video Player — full width */}
        <section className="w-full">
          <LocalVideoPlayer
            ref={playerRef}
            roomId={roomState?.id || ""}
            onPlay={onVideoPlay}
            onPause={onVideoPause}
            onSeek={onVideoSeek}
            onTimeUpdate={(t, d) =>
              setLocalProgress({
                current: t,
                duration: d,
                percent: d > 0 ? (t / d) * 100 : 0,
              })
            }
          />

          {/* Custom Control Bar (below video) */}
          <div
            className={`mt-3 bg-[#FFFFFF] dark:bg-[#0A0A0A] border border-[#E5E7EB] dark:border-[#1F1F23] rounded-xl p-4 shadow-sm transition-opacity duration-300 ${!hasVideo ? "opacity-50 pointer-events-none" : ""}`}
          >
            {/* Seek bar with hover tooltip */}
            <div
              ref={seekBarRef}
              className="relative w-full h-2 bg-gray-100 dark:bg-gray-800 rounded-full cursor-pointer group mb-4 transition-all"
              onClick={(e) => {
                if (!playerRef.current || !localProgress.duration) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(
                  0,
                  Math.min(1, (e.clientX - rect.left) / rect.width),
                );
                const time = pct * localProgress.duration;
                seek(time);
                playerRef.current.seek(time);
              }}
              onMouseMove={(e) => {
                if (!localProgress.duration) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(
                  0,
                  Math.min(1, (e.clientX - rect.left) / rect.width),
                );
                setSeekHover({
                  pct: pct * 100,
                  time: pct * localProgress.duration,
                });
              }}
              onMouseLeave={() => setSeekHover(null)}
            >
              {/* Filled progress */}
              <div
                className="absolute inset-y-0 left-0 bg-foreground rounded-full transition-[width] duration-150"
                style={{ width: `${localProgress.percent}%` }}
              />
              {/* Hover preview bar */}
              {seekHover && (
                <div
                  className="absolute inset-y-0 left-0 bg-white/20 dark:bg-white/10 rounded-full pointer-events-none"
                  style={{ width: `${seekHover.pct}%` }}
                />
              )}
              {/* Hover timestamp tooltip */}
              {seekHover && (
                <div
                  className="absolute -top-8 -translate-x-1/2 pointer-events-none z-10"
                  style={{ left: `${seekHover.pct}%` }}
                >
                  <span className="px-1.5 py-0.5 rounded bg-[#111111] dark:bg-white text-white dark:text-black text-[10px] font-mono font-bold whitespace-nowrap shadow-md">
                    {formatTimestamp(seekHover.time)}
                  </span>
                </div>
              )}
              {/* Thumb */}
              <div
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-[#111111] dark:bg-white shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ left: `${localProgress.percent}%` }}
              />
            </div>

            {/* Controls row */}
            <div className="flex items-center justify-between">
              {/* Left controls */}
              <div className="flex items-center gap-2">
                {/* Play/Pause */}
                <button
                  onClick={handlePlayToggle}
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-[#111111] dark:bg-white text-white dark:text-black hover:opacity-90 transition-opacity shadow-sm"
                  title={roomState?.paused !== false ? "Play" : "Pause"}
                >
                  {roomState?.paused !== false ? (
                    <Play size={16} className="ml-0.5" />
                  ) : (
                    <Pause size={16} />
                  )}
                </button>

                {/* Skip Back 10s */}
                <button
                  onClick={() => {
                    if (!playerRef.current) return;
                    const t = Math.max(
                      0,
                      playerRef.current.getCurrentTime() - 10,
                    );
                    seek(t);
                    playerRef.current.seek(t);
                  }}
                  className="p-2 rounded-lg text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#111111] transition-colors"
                  title="Back 10s"
                >
                  <SkipBack size={16} />
                </button>

                {/* Skip Forward 10s */}
                <button
                  onClick={() => {
                    if (!playerRef.current) return;
                    const t = Math.min(
                      localProgress.duration,
                      playerRef.current.getCurrentTime() + 10,
                    );
                    seek(t);
                    playerRef.current.seek(t);
                  }}
                  className="p-2 rounded-lg text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#111111] transition-colors"
                  title="Forward 10s"
                >
                  <SkipForward size={16} />
                </button>

                {/* Volume control */}
                <div className="flex items-center gap-1.5 ml-1">
                  <button
                    onClick={() => {
                      if (!playerRef.current) return;
                      playerRef.current.toggleMute();
                      setIsMuted(!isMuted);
                    }}
                    className="p-2 rounded-lg text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#111111] transition-colors"
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    {isMuted ? <VolumeOff size={16} /> : <Volume2 size={16} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setVolume(v);
                      setIsMuted(v === 0);
                      playerRef.current?.setVolume(v);
                    }}
                    className="w-20 h-1 accent-[#111111] dark:accent-white cursor-pointer"
                    title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
                  />
                </div>

                {/* Timestamp */}
                <span className="text-xs font-bold font-mono text-[#6B7280] dark:text-[#A1A1AA] ml-2 tabular-nums">
                  {formatTimestamp(localProgress.current)}
                  <span className="mx-1 text-[#D1D5DB] dark:text-[#333]">
                    /
                  </span>
                  {formatTimestamp(localProgress.duration)}
                </span>
              </div>

              {/* Right controls */}
              <div className="flex items-center gap-1">
                {/* Subtitles Toggle */}
                {playerRef.current?.hasSubtitles() && (
                  <button
                    onClick={() => {
                      if (!playerRef.current) return;
                      playerRef.current.toggleSubtitles();
                      setSubtitlesVisible(!subtitlesVisible);
                    }}
                    className={`p-2 rounded-lg transition-colors ${
                      subtitlesVisible
                        ? "text-[#111827] dark:text-white bg-gray-100 dark:bg-[#111111]"
                        : "text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#111111]"
                    }`}
                    title={
                      subtitlesVisible ? "Hide Subtitles" : "Show Subtitles"
                    }
                  >
                    {subtitlesVisible ? (
                      <Captions size={16} />
                    ) : (
                      <CaptionsOff size={16} />
                    )}
                  </button>
                )}

                {/* Room Settings */}
                <RoomSettingsDialog>
                  <button
                    className="p-2 rounded-lg text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#111111] transition-colors"
                    title="Room Settings"
                  >
                    <Settings size={16} />
                  </button>
                </RoomSettingsDialog>

                {/* Fullscreen */}
                <button
                  onClick={() => playerRef.current?.toggleFullscreen()}
                  className="p-2 rounded-lg text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#111111] transition-colors"
                  title="Fullscreen"
                >
                  <Maximize size={16} />
                </button>
              </div>
            </div>

            {/* Bottom stats */}
            <div className="flex items-center justify-between pt-3 mt-3 border-t border-[#E5E7EB] dark:border-[#1F1F23]">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-[#6B7280] dark:text-[#A1A1AA] uppercase tracking-widest">
                    Ping
                  </span>
                  <span className="text-xs font-bold text-[#111827] dark:text-[#EDEDED]">
                    {isConnected ? `${latency}ms` : "reconnecting..."}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${isConnected ? (latency < 100 ? "bg-green-500" : latency < 300 ? "bg-amber-500" : "bg-red-500") : "bg-red-500"}`}
                  ></span>
                </div>
                <div className="h-3 w-px bg-[#E5E7EB] dark:bg-[#1F1F23]"></div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-[#6B7280] dark:text-[#A1A1AA] uppercase tracking-widest">
                    Viewers
                  </span>
                  <span className="text-xs font-bold text-[#111827] dark:text-[#EDEDED]">
                    {activeUsers.length}
                  </span>
                </div>
              </div>
              <div className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA] font-medium">
                {roomState?.permissions?.viewersCanControl
                  ? "All users can control playback"
                  : "Host-only playback control"}
              </div>
            </div>
          </div>
        </section>

        {/* Viewers Table (with latency + timestamps integrated) */}
        <ActiveMembersTable
          activeUsers={activeUsers}
          currentUser={currentUser}
          isConnected={isConnected}
          latency={latency}
          roomState={roomState}
        />
      </main>
    </div>
  );
}
