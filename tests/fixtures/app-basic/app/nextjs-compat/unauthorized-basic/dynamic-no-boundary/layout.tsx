export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1>Dynamic with Layout</h1>
      {children}
    </div>
  );
}
