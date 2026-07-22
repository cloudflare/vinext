if (typeof window !== "undefined") {
  throw new Error("window leaked into SSR module evaluation");
}

if (typeof document !== "undefined") {
  throw new Error("document leaked into SSR module evaluation");
}

export default function Page() {
  return <div>server globals ok</div>;
}
