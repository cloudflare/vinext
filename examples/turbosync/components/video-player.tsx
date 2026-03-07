"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  toggleSubtitles: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getVolume: () => number;
  isMuted: () => boolean;
  isPaused: () => boolean;
  areSubtitlesVisible: () => boolean;
  hasSubtitles: () => boolean;
  getVideoWidth: () => number;
  getVideoHeight: () => number;
}

export interface VideoPlayerClassNames {
  root?: string;
  video?: string;
  overlay?: string;
  progressTrack?: string;
  progressFill?: string;
  progressThumb?: string;
  controlsBar?: string;
  controlsLeft?: string;
  controlsRight?: string;
  button?: string;
  volumeTrack?: string;
  volumeFill?: string;
  timeDisplay?: string;
}

export type VideoPlayerSize = "sm" | "md" | "lg";

export interface VideoPlayerProps {
  children?: React.ReactNode;
  src: string;
  poster?: string;
  subTitlesFile?: string;
  subtitlesLang?: string;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  showControls?: boolean;
  preload?: "auto" | "metadata" | "none";
  size?: VideoPlayerSize;
  accentColor?: string;
  classNames?: VideoPlayerClassNames;
  className?: string;
  controlsTimeout?: number;
  seekStep?: number;
  volumeStep?: number;
  disableKeyboardShortcuts?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onLoadedMetadata?: (duration: number) => void;
  onEnded?: () => void;
  onVolumeChange?: (volume: number, muted: boolean) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  onSeek?: (time: number) => void;
  renderPlayButton?: (
    isPlaying: boolean,
    toggle: () => void,
  ) => React.ReactNode;
  renderMuteButton?: (isMuted: boolean, toggle: () => void) => React.ReactNode;
  renderFullscreenButton?: (
    isFullscreen: boolean,
    toggle: () => void,
  ) => React.ReactNode;
  renderTimeDisplay?: (
    currentTime: number,
    duration: number,
    formatted: { current: string; total: string },
  ) => React.ReactNode;
  renderExtraControlsLeft?: () => React.ReactNode;
  renderExtraControlsRight?: () => React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Size presets                                                       */
/* ------------------------------------------------------------------ */

const SIZE_STYLES: Record<
  VideoPlayerSize,
  { controls: string; icon: string; text: string; padding: string }
> = {
  sm: {
    controls: "gap-1.5",
    icon: "size-3.5",
    text: "text-[10px]",
    padding: "px-2.5 py-1.5",
  },
  md: {
    controls: "gap-2.5",
    icon: "size-4",
    text: "text-xs",
    padding: "px-3.5 py-2",
  },
  lg: {
    controls: "gap-3",
    icon: "size-5",
    text: "text-sm",
    padding: "px-4 py-3",
  },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const VideoPlayer = React.forwardRef<
  VideoPlayerHandle,
  VideoPlayerProps
>(
  (
    {
      src,
      poster,
      subTitlesFile,
      subtitlesLang = "en",
      autoPlay = false,
      loop = false,
      muted = false,
      showControls = true,
      preload = "metadata",

      // Customization
      size = "md",
      accentColor,
      classNames = {},
      className,
      controlsTimeout = 3000,
      seekStep = 5,
      volumeStep = 0.1,
      disableKeyboardShortcuts = false,

      // Callbacks
      onPlay,
      onPause,
      onTimeUpdate,
      onLoadedMetadata,
      onEnded,
      onVolumeChange,
      onFullscreenChange,
      onSeek,

      // Render Slots
      renderPlayButton,
      renderMuteButton,
      renderFullscreenButton,
      renderTimeDisplay,
      renderExtraControlsLeft,
      renderExtraControlsRight,
      children,
    },
    ref,
  ) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const progressTrackRef = useRef<HTMLDivElement>(null);
    const hideControlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    const [isPlaying, setIsPlaying] = useState(autoPlay);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isMuted, setIsMuted] = useState(muted);
    const [volume, setVolume] = useState(muted ? 0 : 1);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControlsUI, setShowControlsUI] = useState(true);
    const [isDraggingProgress, setIsDraggingProgress] = useState(false);
    const [hoverProgress, setHoverProgress] = useState<number | null>(null);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [isDraggingVolume, setIsDraggingVolume] = useState(false);
    const [subtitlesVisible, setSubtitlesVisible] = useState(true);

    const sizePreset = SIZE_STYLES[size];

    // Accent color as CSS variable
    const accentStyle = useMemo(
      () =>
        accentColor
          ? ({ "--vp-accent": accentColor } as React.CSSProperties)
          : undefined,
      [accentColor],
    );

    const accentBg = accentColor ? "bg-[var(--vp-accent)]" : "bg-red-500";

    /* ---- Imperative handle ---------------------------------------- */

    useEffect(() => {
      if (!ref) return;

      const handle: VideoPlayerHandle = {
        play: () => videoRef.current?.play().catch(() => {}),
        pause: () => videoRef.current?.pause(),
        seek: (time) => {
          if (videoRef.current) {
            videoRef.current.currentTime = clamp(
              time,
              0,
              videoRef.current.duration,
            );
          }
        },
        setVolume: (v) => {
          if (videoRef.current) {
            const clamped = clamp(v, 0, 1);
            videoRef.current.volume = clamped;
            setVolume(clamped);
          }
        },
        toggleMute: () => handleMuteToggle(),
        toggleFullscreen: () => handleFullscreen(),
        toggleSubtitles: () => handleSubtitleToggle(),
        getCurrentTime: () => videoRef.current?.currentTime ?? 0,
        getDuration: () => videoRef.current?.duration ?? 0,
        getVolume: () => videoRef.current?.volume ?? 0,
        isMuted: () => videoRef.current?.muted ?? false,
        isPaused: () => videoRef.current?.paused ?? true,
        areSubtitlesVisible: () => subtitlesVisible,
        hasSubtitles: () => !!subTitlesFile,
        getVideoWidth: () => videoRef.current?.videoWidth ?? 0,
        getVideoHeight: () => videoRef.current?.videoHeight ?? 0,
      };

      if (typeof ref === "function") {
        ref(handle);
      } else {
        ref.current = handle;
      }
    });

    /* ---- Event handlers ------------------------------------------- */

    const handlePlayPause = useCallback(() => {
      if (!videoRef.current) return;
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
      } else {
        videoRef.current.pause();
      }
    }, []);

    const handleSeek = useCallback(
      (time: number) => {
        if (!videoRef.current) return;
        const clamped = clamp(time, 0, videoRef.current.duration || 0);
        videoRef.current.currentTime = clamped;
        onSeek?.(clamped);
      },
      [onSeek],
    );

    const handleVolumeChange = useCallback(
      (newVolume: number) => {
        if (!videoRef.current) return;
        const vol = clamp(newVolume, 0, 1);
        videoRef.current.volume = vol;
        videoRef.current.muted = vol === 0;
        setVolume(vol);
        setIsMuted(vol === 0);
        onVolumeChange?.(vol, vol === 0);
      },
      [onVolumeChange],
    );

    const handleMuteToggle = useCallback(() => {
      if (!videoRef.current) return;
      const newMuted = !videoRef.current.muted;
      videoRef.current.muted = newMuted;
      setIsMuted(newMuted);
      onVolumeChange?.(volume, newMuted);
    }, [onVolumeChange, volume]);

    const handleFullscreen = useCallback(() => {
      if (!containerRef.current) return;

      if (!document.fullscreenElement) {
        containerRef.current.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    }, []);

    const handleSubtitleToggle = useCallback(() => {
      if (!videoRef.current) return;
      const track = videoRef.current.textTracks[0];
      if (track) {
        const newVisible = track.mode !== "showing";
        track.mode = newVisible ? "showing" : "disabled";
        setSubtitlesVisible(newVisible);
      }
    }, []);

    // Sync fullscreen state with browser
    useEffect(() => {
      const onFsChange = () => {
        const fs = !!document.fullscreenElement;
        setIsFullscreen(fs);
        onFullscreenChange?.(fs);
      };
      document.addEventListener("fullscreenchange", onFsChange);
      return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, [onFullscreenChange]);

    /* ---- Auto-hide controls --------------------------------------- */

    const scheduleHideControls = useCallback(() => {
      if (hideControlsTimeoutRef.current) {
        clearTimeout(hideControlsTimeoutRef.current);
      }
      if (controlsTimeout > 0 && isPlaying && showControls) {
        hideControlsTimeoutRef.current = setTimeout(() => {
          setShowControlsUI(false);
        }, controlsTimeout);
      }
    }, [isPlaying, showControls, controlsTimeout]);

    const handleMouseActivity = useCallback(() => {
      setShowControlsUI(true);
      scheduleHideControls();
    }, [scheduleHideControls]);

    useEffect(() => {
      return () => {
        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }
      };
    }, []);

    /* ---- Progress bar drag --------------------------------------- */

    const getProgressFromEvent = useCallback(
      (e: MouseEvent | React.MouseEvent) => {
        if (!progressTrackRef.current || !duration) return 0;
        const rect = progressTrackRef.current.getBoundingClientRect();
        return clamp((e.clientX - rect.left) / rect.width, 0, 1) * duration;
      },
      [duration],
    );

    useEffect(() => {
      if (!isDraggingProgress) return;

      const onMove = (e: MouseEvent) => {
        const time = getProgressFromEvent(e);
        setCurrentTime(time);
      };

      const onUp = (e: MouseEvent) => {
        const time = getProgressFromEvent(e);
        handleSeek(time);
        setIsDraggingProgress(false);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
    }, [isDraggingProgress, getProgressFromEvent, handleSeek]);

    /* ---- Keyboard shortcuts --------------------------------------- */

    useEffect(() => {
      if (disableKeyboardShortcuts) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        // Only handle if the player or its children are focused
        if (!containerRef.current?.contains(document.activeElement)) return;

        switch (e.key) {
          case " ":
          case "k":
            e.preventDefault();
            handlePlayPause();
            break;
          case "ArrowLeft":
            e.preventDefault();
            handleSeek(
              clamp(
                (videoRef.current?.currentTime ?? 0) - seekStep,
                0,
                duration,
              ),
            );
            break;
          case "ArrowRight":
            e.preventDefault();
            handleSeek(
              clamp(
                (videoRef.current?.currentTime ?? 0) + seekStep,
                0,
                duration,
              ),
            );
            break;
          case "ArrowUp":
            e.preventDefault();
            handleVolumeChange(
              clamp((videoRef.current?.volume ?? 1) + volumeStep, 0, 1),
            );
            break;
          case "ArrowDown":
            e.preventDefault();
            handleVolumeChange(
              clamp((videoRef.current?.volume ?? 1) - volumeStep, 0, 1),
            );
            break;
          case "m":
            e.preventDefault();
            handleMuteToggle();
            break;
          case "f":
            e.preventDefault();
            handleFullscreen();
            break;
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
      disableKeyboardShortcuts,
      handlePlayPause,
      handleSeek,
      handleVolumeChange,
      handleMuteToggle,
      handleFullscreen,
      seekStep,
      volumeStep,
      duration,
    ]);

    /* ---- Volume drag (window-level) -------------------------------- */

    useEffect(() => {
      if (!isDraggingVolume) return;

      const onMove = (e: MouseEvent) => {
        const volSlider =
          containerRef.current?.querySelector<HTMLDivElement>(
            "[data-vol-track]",
          );
        if (!volSlider) return;
        const rect = volSlider.getBoundingClientRect();
        const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        handleVolumeChange(pct);
      };

      const onUp = () => setIsDraggingVolume(false);

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
    }, [isDraggingVolume, handleVolumeChange]);

    /* ---- Computed values ------------------------------------------ */

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    const volumePercent = volume * 100;
    const formattedCurrent = formatTime(currentTime);
    const formattedDuration = formatTime(duration);

    /* ---- Render --------------------------------------------------- */

    return (
      <div
        ref={containerRef}
        className={cn(
          "group/player relative w-full overflow-hidden bg-black font-sans select-none",
          className,
          classNames.root,
        )}
        style={accentStyle}
        tabIndex={-1}
        onMouseMove={showControls ? handleMouseActivity : undefined}
        onMouseLeave={() => {
          if (hideControlsTimeoutRef.current) {
            clearTimeout(hideControlsTimeoutRef.current);
          }
          if (isPlaying && showControls && controlsTimeout > 0) {
            setShowControlsUI(false);
          }
        }}
      >
        {/* Video Element */}
        <video
          ref={videoRef}
          className={cn("block h-full w-full", classNames.video)}
          autoPlay={autoPlay}
          loop={loop}
          muted={muted}
          poster={poster}
          preload={preload}
          onClick={handlePlayPause}
          onTimeUpdate={() => {
            if (!isDraggingProgress) {
              const t = videoRef.current?.currentTime ?? 0;
              setCurrentTime(t);
              onTimeUpdate?.(t, duration);
            }
          }}
          onLoadedMetadata={() => {
            const d = videoRef.current?.duration ?? 0;
            setDuration(d);
            onLoadedMetadata?.(d);
          }}
          onPlay={() => {
            setIsPlaying(true);
            onPlay?.();
          }}
          onPause={() => {
            setIsPlaying(false);
            onPause?.();
          }}
          onEnded={() => onEnded?.()}
          onVolumeChange={() => {
            if (videoRef.current) {
              setVolume(videoRef.current.volume);
              setIsMuted(videoRef.current.muted);
            }
          }}
        >
          {children}
          <source src={src} type="video/mp4" />
          {subTitlesFile && (
            <track
              kind="captions"
              srcLang={subtitlesLang}
              src={subTitlesFile}
              default
            />
          )}
          Your browser does not support the video tag.
        </video>

        {/* Controls Overlay */}
        {showControls && (
          <section
            aria-label="Video player controls overlay"
            className={cn(
              "absolute inset-0 flex flex-col justify-end transition-opacity duration-300",
              showControlsUI || !isPlaying
                ? "opacity-100"
                : "pointer-events-none opacity-0",
              classNames.overlay,
            )}
            style={{
              background:
                showControlsUI || !isPlaying
                  ? "linear-gradient(transparent 50%, rgba(0, 0, 0, 0.75))"
                  : "transparent",
              cursor: isPlaying && !showControlsUI ? "none" : "default",
            }}
          >
            {/* Progress Bar */}
            <div
              ref={progressTrackRef}
              role="slider"
              tabIndex={0}
              aria-label="Video progress"
              aria-valuemin={0}
              aria-valuemax={Math.ceil(duration)}
              aria-valuenow={Math.ceil(currentTime)}
              className={cn(
                "group/progress relative h-1 w-full cursor-pointer transition-[height] hover:h-1.5",
                classNames.progressTrack,
              )}
              onClick={(e) => {
                if (isDraggingProgress) return;
                const time = getProgressFromEvent(e as unknown as MouseEvent);
                handleSeek(time);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDraggingProgress(true);
                const time = getProgressFromEvent(e as unknown as MouseEvent);
                setCurrentTime(time);
              }}
              onMouseMove={(e) => {
                if (!progressTrackRef.current || !duration) return;
                const rect = progressTrackRef.current.getBoundingClientRect();
                const pct =
                  clamp((e.clientX - rect.left) / rect.width, 0, 1) * 100;
                setHoverProgress(pct);
                setHoverTime((pct / 100) * duration);
              }}
              onMouseLeave={() => {
                setHoverProgress(null);
                setHoverTime(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  handleSeek(Math.max(0, currentTime - seekStep));
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  handleSeek(Math.min(duration, currentTime + seekStep));
                }
              }}
            >
              {/* Track background */}
              <div className="absolute inset-0 rounded-full bg-white/25" />

              {/* Hover preview */}
              {hoverProgress !== null && (
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-white/20"
                  style={{ width: `${hoverProgress}%` }}
                />
              )}

              {/* Hover timestamp tooltip */}
              {hoverProgress !== null && hoverTime !== null && (
                <div
                  className="absolute -top-8 -translate-x-1/2 pointer-events-none z-10"
                  style={{ left: `${hoverProgress}%` }}
                >
                  <span className="px-1.5 py-0.5 rounded bg-black/90 text-white text-[10px] font-mono whitespace-nowrap shadow-md">
                    {formatTime(hoverTime)}
                  </span>
                </div>
              )}

              {/* Filled progress */}
              <div
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  accentBg,
                  classNames.progressFill,
                )}
                style={{
                  width: `${progressPercent}%`,
                  transition: isDraggingProgress
                    ? "none"
                    : "width 100ms linear",
                }}
              />

              {/* Thumb */}
              <div
                className={cn(
                  "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 shadow-md transition-opacity group-hover/progress:opacity-100",
                  accentBg,
                  size === "sm"
                    ? "size-2.5"
                    : size === "lg"
                      ? "size-4"
                      : "size-3",
                  isDraggingProgress && "opacity-100",
                  classNames.progressThumb,
                )}
                style={{ left: `${progressPercent}%` }}
              />
            </div>

            {/* Controls Bar */}
            <div
              className={cn(
                "flex items-center justify-between",
                sizePreset.padding,
                sizePreset.controls,
                classNames.controlsBar,
              )}
            >
              {/* Left Controls */}
              <div
                className={cn(
                  "flex items-center",
                  sizePreset.controls,
                  classNames.controlsLeft,
                )}
              >
                {/* Play / Pause */}
                {renderPlayButton ? (
                  renderPlayButton(isPlaying, handlePlayPause)
                ) : (
                  <button
                    type="button"
                    onClick={handlePlayPause}
                    className={cn(
                      "flex cursor-pointer items-center justify-center rounded-sm p-1 text-white/90 transition-colors hover:text-white",
                      classNames.button,
                    )}
                    aria-label={isPlaying ? "Pause" : "Play"}
                    title={isPlaying ? "Pause" : "Play"}
                  >
                    {isPlaying ? (
                      <Pause className={sizePreset.icon} />
                    ) : (
                      <Play className={cn(sizePreset.icon, "ml-0.5")} />
                    )}
                  </button>
                )}

                {/* Mute / Unmute */}
                {renderMuteButton ? (
                  renderMuteButton(isMuted, handleMuteToggle)
                ) : (
                  <button
                    type="button"
                    onClick={handleMuteToggle}
                    className={cn(
                      "flex cursor-pointer items-center justify-center rounded-sm p-1 text-white/90 transition-colors hover:text-white",
                      classNames.button,
                    )}
                    aria-label={isMuted ? "Unmute" : "Mute"}
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    {isMuted ? (
                      <VolumeOff className={sizePreset.icon} />
                    ) : (
                      <Volume2 className={sizePreset.icon} />
                    )}
                  </button>
                )}

                {/* Volume Slider */}
                <div
                  data-vol-track
                  className={cn(
                    "group/vol relative flex h-full cursor-pointer items-center",
                    size === "sm" ? "w-14" : size === "lg" ? "w-24" : "w-20",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsDraggingVolume(true);
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = clamp(
                      (e.clientX - rect.left) / rect.width,
                      0,
                      1,
                    );
                    handleVolumeChange(pct);
                  }}
                >
                  <div
                    className={cn(
                      "relative h-1 w-full rounded-full bg-white/25",
                      classNames.volumeTrack,
                    )}
                  >
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full",
                        accentBg,
                        classNames.volumeFill,
                      )}
                      style={{ width: `${volumePercent}%` }}
                    />
                    <div
                      className={cn(
                        "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-sm transition-opacity group-hover/vol:opacity-100",
                        isDraggingVolume && "opacity-100",
                      )}
                      style={{ left: `${volumePercent}%` }}
                    />
                  </div>
                </div>

                {/* Time Display */}
                {renderTimeDisplay ? (
                  renderTimeDisplay(currentTime, duration, {
                    current: formattedCurrent,
                    total: formattedDuration,
                  })
                ) : (
                  <span
                    className={cn(
                      "whitespace-nowrap font-mono text-white/80",
                      sizePreset.text,
                      classNames.timeDisplay,
                    )}
                  >
                    {formattedCurrent} / {formattedDuration}
                  </span>
                )}

                {renderExtraControlsLeft?.()}
              </div>

              {/* Right Controls */}
              <div
                className={cn(
                  "flex items-center",
                  sizePreset.controls,
                  classNames.controlsRight,
                )}
              >
                {renderExtraControlsRight?.()}

                {/* Fullscreen */}
                {renderFullscreenButton ? (
                  renderFullscreenButton(isFullscreen, handleFullscreen)
                ) : (
                  <button
                    type="button"
                    onClick={handleFullscreen}
                    className={cn(
                      "flex cursor-pointer items-center justify-center rounded-sm p-1 text-white/90 transition-colors hover:text-white",
                      classNames.button,
                    )}
                    aria-label={
                      isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
                    }
                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                  >
                    {isFullscreen ? (
                      <Minimize className={sizePreset.icon} />
                    ) : (
                      <Maximize className={sizePreset.icon} />
                    )}
                  </button>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    );
  },
);

VideoPlayer.displayName = "VideoPlayer";

export default VideoPlayer;
