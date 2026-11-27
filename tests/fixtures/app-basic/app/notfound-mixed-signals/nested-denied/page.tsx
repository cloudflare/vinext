import { forbidden } from "next/navigation";

// A Server Component the page renders throws, which nothing tags.
function Gate(): React.ReactNode {
  forbidden();
}

export default function Page() {
  return <Gate />;
}
