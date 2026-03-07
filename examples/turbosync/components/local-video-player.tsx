"use client";

import React, {
  useCallback,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useEffect,
} from "react";
import { VideoPlayer, VideoPlayerHandle } from "@/components/video-player";
import { useRoom } from "@/lib/room-context";
import { Upload, Film, Subtitles } from "lucide-react";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/*  IndexedDB Helpers                                                  */
/* ------------------------------------------------------------------ */

const DB_NAME = "turbosync_db";
const STORE_NAME = "files";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFile(roomId: string, file: File): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(file, `video_${roomId}`);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("Failed to save to indexedDB", err);
  }
}

async function getFile(roomId: string): Promise<File | undefined> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(`video_${roomId}`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("Failed to read from indexedDB", err);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  Public handle — same shape as VideoPlayerHandle                     */
/* ------------------------------------------------------------------ */

export type LocalVideoPlayerHandle = VideoPlayerHandle;

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface LocalVideoPlayerProps {
  /** The id of the room, required for caching */
  roomId: string;
  /** Called when user plays the video locally */
  onPlay?: (currentTime: number) => void;
  /** Called when user pauses the video locally */
  onPause?: (currentTime: number) => void;
  /** Called when user seeks the video locally */
  onSeek?: (currentTime: number) => void;
  /** Called on every timeupdate */
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  /** Called when metadata loads (resolution available) */
  onLoadedMetadata?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const LocalVideoPlayer = forwardRef<
  LocalVideoPlayerHandle,
  LocalVideoPlayerProps
>(
  (
    { roomId, onPlay, onPause, onSeek, onTimeUpdate, onLoadedMetadata },
    ref,
  ) => {
    const playerRef = useRef<VideoPlayerHandle>(null);
    const { roomState } = useRoom();

    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [subtitleSrc, setSubtitleSrc] = useState<string | null>(null);
    const [resolution, setResolution] = useState<{
      w: number;
      h: number;
    } | null>(null);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const videoInputRef = useRef<HTMLInputElement>(null);
    const subtitleInputRef = useRef<HTMLInputElement>(null);

    // Forward handle from inner VideoPlayer
    useImperativeHandle(ref, () => ({
      play: () => playerRef.current?.play(),
      pause: () => playerRef.current?.pause(),
      seek: (t: number) => playerRef.current?.seek(t),
      setVolume: (v: number) => playerRef.current?.setVolume(v),
      toggleMute: () => playerRef.current?.toggleMute(),
      toggleFullscreen: () => playerRef.current?.toggleFullscreen(),
      toggleSubtitles: () => playerRef.current?.toggleSubtitles(),
      getCurrentTime: () => playerRef.current?.getCurrentTime() ?? 0,
      getDuration: () => playerRef.current?.getDuration() ?? 0,
      getVolume: () => playerRef.current?.getVolume() ?? 0,
      isMuted: () => playerRef.current?.isMuted() ?? false,
      isPaused: () => playerRef.current?.isPaused() ?? true,
      areSubtitlesVisible: () =>
        playerRef.current?.areSubtitlesVisible() ?? false,
      hasSubtitles: () => playerRef.current?.hasSubtitles() ?? false,
      getVideoWidth: () => playerRef.current?.getVideoWidth() ?? 0,
      getVideoHeight: () => playerRef.current?.getVideoHeight() ?? 0,
    }));

    /* ---- File handling -------------------------------------------- */

    const handleVideoFile = useCallback(
      (file: File, restore = false) => {
        if (!file.type.startsWith("video/")) {
          toast.error("Invalid file", {
            description: "Please select a video file (.mp4, .mkv, .webm).",
          });
          return;
        }
        setVideoSrc(URL.createObjectURL(file));
        if (!restore) {
          saveFile(roomId, file);
          toast.success("Video loaded", { description: file.name });
        } else {
          toast.info("Restored previous video", { description: file.name });
        }
      },
      [roomId],
    );

    const handleSubtitleFile = useCallback((file: File) => {
      if (!file.name.endsWith(".vtt") && !file.name.endsWith(".srt")) {
        toast.error("Invalid file", {
          description: "Please select a subtitle file (.vtt or .srt).",
        });
        return;
      }
      setSubtitleSrc(URL.createObjectURL(file));
      toast.success("Subtitles loaded", { description: file.name });
    }, []);

    /* ---- Drag & Drop --------------------------------------------- */

    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingOver(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingOver(false);
    }, []);

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        setIsDraggingOver(false);

        const files = Array.from(e.dataTransfer.files);
        for (const file of files) {
          if (file.type.startsWith("video/")) {
            handleVideoFile(file);
          } else if (file.name.endsWith(".vtt") || file.name.endsWith(".srt")) {
            handleSubtitleFile(file);
          }
        }
      },
      [handleVideoFile, handleSubtitleFile],
    );

    /* ---- Restore from IndexedDB on mount ------------------------- */

    useEffect(() => {
      if (!roomId) return;
      let mounted = true;
      getFile(roomId).then((file) => {
        if (mounted && file) {
          handleVideoFile(file, true);
        }
      });
      return () => {
        mounted = false;
      };
    }, [roomId, handleVideoFile]);

    /* ---- Metadata loaded: sync with room state ------------------- */

    const handleLoadedMetadata = useCallback(() => {
      const w = playerRef.current?.getVideoWidth() || 0;
      const h = playerRef.current?.getVideoHeight() || 0;
      if (w > 0 && h > 0) setResolution({ w, h });

      // Sync with room state on first load (seek to server time, play if room is playing)
      if (roomState && playerRef.current) {
        playerRef.current.seek(roomState.currentTime);
        // Don't autoplay — only play if room is currently playing
        if (!roomState.paused) {
          playerRef.current.play();
        }
      }

      onLoadedMetadata?.();
    }, [roomState, onLoadedMetadata]);

    /* ---- Resolution label ---------------------------------------- */

    const resLabel = resolution ? `${resolution.w}×${resolution.h}` : null;

    /* ---- Render: no video loaded → drop zone --------------------- */

    if (!videoSrc) {
      return (
        <div
          className="w-full"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className={`
            relative w-full aspect-video rounded-xl border-2 border-dashed
            flex flex-col items-center justify-center gap-4
            transition-all duration-300 cursor-pointer
            ${
              isDraggingOver
                ? "border-blue-500 bg-blue-500/10 scale-[1.01] shadow-lg shadow-blue-500/20"
                : "border-[#E5E7EB] dark:border-[#1F1F23] bg-[#FAFAFA] dark:bg-[#0A0A0A] hover:border-[#999] dark:hover:border-[#444]"
            }
          `}
            onClick={() => videoInputRef.current?.click()}
          >
            {/* Animated upload icon */}
            <div
              className={`
              p-4 rounded-2xl transition-all duration-300
              ${isDraggingOver ? "bg-blue-500/20 scale-110" : "bg-[#F3F4F6] dark:bg-[#111111]"}
            `}
            >
              <Upload
                size={32}
                className={`transition-colors duration-300 ${
                  isDraggingOver
                    ? "text-blue-500"
                    : "text-[#6B7280] dark:text-[#A1A1AA]"
                }`}
              />
            </div>

            <div className="text-center">
              <p
                className={`text-sm font-semibold transition-colors ${
                  isDraggingOver
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-[#111827] dark:text-[#EDEDED]"
                }`}
              >
                {isDraggingOver
                  ? "Drop your file here"
                  : "Drag & drop a video file"}
              </p>
              <p className="text-xs text-[#6B7280] dark:text-[#A1A1AA] mt-1">
                or click to browse · MP4, WebM, MKV
              </p>
            </div>

            {/* Subtitle upload button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                subtitleInputRef.current?.click();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-[#EDEDED] border border-[#E5E7EB] dark:border-[#1F1F23] rounded-lg hover:bg-[#F3F4F6] dark:hover:bg-[#111111] transition-colors"
            >
              <Subtitles size={14} />
              Add subtitles (.vtt)
            </button>

            {subtitleSrc && (
              <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">
                ✓ Subtitles loaded
              </span>
            )}
          </div>

          {/* Hidden file inputs */}
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleVideoFile(file);
            }}
          />
          <input
            ref={subtitleInputRef}
            type="file"
            accept=".vtt,.srt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleSubtitleFile(file);
            }}
          />
        </div>
      );
    }

    /* ---- Render: video loaded → player --------------------------- */

    return (
      <div
        className="w-full relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay on top of playing video */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-xl flex items-center justify-center backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <Upload size={40} className="text-blue-500" />
              <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
                Drop to replace
              </span>
            </div>
          </div>
        )}

        {/* Resolution badge */}
        {resLabel && (
          <div className="absolute top-3 right-3 z-30 px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[10px] font-mono font-bold text-white/80 border border-white/10">
            {resLabel}
          </div>
        )}

        <VideoPlayer
          ref={playerRef}
          src={videoSrc}
          subTitlesFile={subtitleSrc || undefined}
          showControls={isFullscreen}
          size="lg"
          accentColor="white"
          className="w-full aspect-video rounded-xl overflow-hidden"
          onPlay={() => onPlay?.(playerRef.current?.getCurrentTime() ?? 0)}
          onPause={() => onPause?.(playerRef.current?.getCurrentTime() ?? 0)}
          onSeek={(time) => onSeek?.(time)}
          onTimeUpdate={(current, dur) => onTimeUpdate?.(current, dur)}
          onLoadedMetadata={handleLoadedMetadata}
          onFullscreenChange={(fs) => setIsFullscreen(fs)}
        />

        {/* Bottom toolbar: swap video / add subtitles */}
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-[#EDEDED] border border-[#E5E7EB] dark:border-[#1F1F23] rounded-lg hover:bg-[#F3F4F6] dark:hover:bg-[#111111] transition-colors"
          >
            <Film size={14} />
            Change Video
          </button>
          <button
            type="button"
            onClick={() => subtitleInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-[#6B7280] dark:text-[#A1A1AA] hover:text-[#111827] dark:hover:text-[#EDEDED] border border-[#E5E7EB] dark:border-[#1F1F23] rounded-lg hover:bg-[#F3F4F6] dark:hover:bg-[#111111] transition-colors"
          >
            <Subtitles size={14} />
            {subtitleSrc ? "Change Subtitles" : "Add Subtitles"}
          </button>
        </div>

        {/* Hidden file inputs */}
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleVideoFile(file);
          }}
        />
        <input
          ref={subtitleInputRef}
          type="file"
          accept=".vtt,.srt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleSubtitleFile(file);
          }}
        />
      </div>
    );
  },
);

LocalVideoPlayer.displayName = "LocalVideoPlayer";
