import NavBar from "./nav-bar";

export default function UseLinkStatusLayout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <NavBar />
      {children}
    </main>
  );
}
