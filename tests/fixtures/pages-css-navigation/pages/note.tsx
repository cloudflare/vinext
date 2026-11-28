import dynamic from "next/dynamic";

const BadgeNote = dynamic(() => import("../components/badge-note"));

export default function Note() {
  return (
    <div data-page="note">
      <BadgeNote />
    </div>
  );
}
