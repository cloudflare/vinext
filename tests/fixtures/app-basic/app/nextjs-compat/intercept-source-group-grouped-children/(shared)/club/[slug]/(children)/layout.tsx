/**
 * Test fixture: a layout of the route group holding the club page. The whole
 * intercepting route stops at the club folder, so it never renders this.
 */
export default function ClubChildrenLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="intercept-grouped-children-group-layout">
      <p>Club group layout</p>
      {children}
    </div>
  );
}
