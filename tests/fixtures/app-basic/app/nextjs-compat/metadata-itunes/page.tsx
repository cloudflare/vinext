import type { Metadata } from "next";

export const metadata: Metadata = {
  itunes: {
    appId: "123456789",
    appArgument: "myapp://content/123",
  },
};

export default function Page() {
  return <div id="itunes">iTunes page</div>;
}
