import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://base.example.com"),
  openGraph: {
    videos: [
      "/video-1.mp4",
      new URL("https://example.com/video-2.mp4"),
      { url: new URL("https://example.com/video-3.mp4") },
    ],
    audio: [
      { url: "/audio-1.mp3", type: "audio/mpeg" },
      new URL("https://example.com/audio-2.mp3"),
    ],
  },
};

export default function Page() {
  return <div id="opengraph-video-audio-list">OpenGraph video and audio list page</div>;
}
