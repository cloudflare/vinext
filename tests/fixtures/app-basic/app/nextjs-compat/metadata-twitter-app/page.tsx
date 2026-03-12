import type { Metadata } from "next";

export const metadata: Metadata = {
  twitter: {
    card: "app",
    title: "App Title",
    description: "App Description",
    site: "@example",
    app: {
      id: {
        iphone: "id123456789",
        ipad: "id123456789",
        googleplay: "com.example.app",
      },
      url: {
        iphone: "https://example.com/iphone",
        ipad: "https://example.com/ipad",
        googleplay: "https://example.com/android",
      },
      name: "My App",
    },
  },
};

export default function Page() {
  return <div id="twitter-app">Twitter App page</div>;
}
