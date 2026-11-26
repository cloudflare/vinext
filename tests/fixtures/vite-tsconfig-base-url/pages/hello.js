import { World } from "components/world";

export function getServerSideProps() {
  return { props: {} };
}

export default function HelloPage() {
  return (
    <div>
      <World />
    </div>
  );
}
