export default function TeamSlotLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="team-slot-layout">
      <nav data-testid="team-slot-nav">
        <span>Team Nav</span>
      </nav>
      {children}
    </div>
  );
}
