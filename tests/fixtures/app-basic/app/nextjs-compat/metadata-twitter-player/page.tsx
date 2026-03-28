import type { Metadata } from "next";

export const metadata: Metadata = {
  twitter: {
    card: "player",
    title: "Video Title",
    description: "Video Description",
    site: "@example",
    players: {
      playerUrl: "https://example.com/player",
      streamUrl: "https://example.com/stream",
      width: 480,
      height: 360,
    },
  },
};

export default function Page() {
  return <div id="twitter-player">Twitter Player page</div>;
}
