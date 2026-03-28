import type { Metadata } from "next";

export const metadata: Metadata = {
  appLinks: {
    ios: {
      url: "https://example.com/ios",
      app_store_id: "123456789",
      app_name: "My iOS App",
    },
    android: {
      package: "com.example.app",
      url: "https://example.com/android",
      app_name: "My Android App",
    },
    web: {
      url: "https://example.com",
      should_fallback: true,
    },
  },
};

export default function Page() {
  return <div id="applinks">App Links page</div>;
}
