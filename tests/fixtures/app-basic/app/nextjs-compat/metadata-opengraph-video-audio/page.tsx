import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://base.example.com"),
  openGraph: {
    videos: {
      url: "/video.mp4",
      secureUrl: "/secure-video.mp4",
      type: "video/mp4",
      width: 800,
      height: 600,
    },
    audio: "/audio.mp3",
  },
};

export default function Page() {
  return <div id="opengraph-video-audio">OpenGraph single video and audio page</div>;
}
