export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", gap: "1rem", padding: "0.5rem", background: "#fafafa", marginBottom: "1rem" }}>
        <a href="/settings">General</a>
        <a href="/settings/profile">Profile</a>
        <a href="/settings/notifications">Notifications</a>
        <a href="/settings/billing">Billing</a>
      </div>
      {children}
    </div>
  );
}

