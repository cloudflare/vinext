export default function StaffPanelPage({ access }: { access: string }) {
  return <main>protected pages staff panel {access}</main>;
}

export function getServerSideProps() {
  return { props: { access: "protected pages staff props" } };
}
