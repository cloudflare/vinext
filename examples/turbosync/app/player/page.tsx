"use client";

import { useRef, useState } from "react";
import VideoPlayer from "@/components/video-player";
import type { VideoPlayerHandle } from "@/components/video-player";

export default function PlayerPage() {
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [subTitlesSrc, setSubtitlesSrc] = useState<string>("");
  const playerRef = useRef<VideoPlayerHandle>(null);

  const handleVideoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const videoURL = URL.createObjectURL(file);
      setVideoSrc(videoURL);
    }
  };

  const handleSubtitlesUpload = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      const subtitlesURL = URL.createObjectURL(file);
      setSubtitlesSrc(subtitlesURL);
    }
  };

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center gap-6 p-6">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Video Player Demo</h1>
        <p className="text-sm text-muted-foreground">
          Upload a video to test the embeddable headless player. Use keyboard
          shortcuts:{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">Space</kbd>{" "}
          play/pause,{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">←</kbd>{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">→</kbd> seek,{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">↑</kbd>{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">↓</kbd> volume,{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">M</kbd> mute,{" "}
          <kbd className="rounded border px-1 py-0.5 text-xs">F</kbd>{" "}
          fullscreen.
        </p>

        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="video-upload" className="text-sm font-medium">
              Upload Video File
            </label>
            <input
              id="video-upload"
              type="file"
              accept="video/*"
              onChange={handleVideoUpload}
              aria-label="Upload video file"
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="subtitles-upload" className="text-sm font-medium">
              Upload Subtitles (.vtt)
            </label>
            <input
              id="subtitles-upload"
              type="file"
              accept=".vtt"
              aria-label="Upload subtitles file"
              onChange={handleSubtitlesUpload}
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => playerRef.current?.play()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Play
          </button>
          <button
            type="button"
            onClick={() => playerRef.current?.pause()}
            className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => playerRef.current?.seek(0)}
            className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
          >
            Restart
          </button>
        </div>
      </div>

      {videoSrc && (
        <div className="w-full max-w-3xl overflow-hidden rounded-xl shadow-lg">
          <VideoPlayer
            ref={playerRef}
            src={videoSrc}
            subTitlesFile={subTitlesSrc}
            subtitlesLang="en"
            showControls
            size="md"
            classNames={{
              root: "rounded-xl",
            }}
          />
        </div>
      )}
    </main>
  );
}
