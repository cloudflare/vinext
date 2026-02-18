import { getGreeting } from "@/lib/greeting";

export default function BaseUrlTestPage() {
  const message = getGreeting("baseUrl");
  return (
    <div>
      <h1>BaseUrl Test</h1>
      <p>{message}</p>
    </div>
  );
}
