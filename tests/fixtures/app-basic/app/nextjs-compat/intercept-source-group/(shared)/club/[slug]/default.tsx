// The owner's children when a page without the modal slot opens the modal,
// so the whole intercepting route renders beneath this layout, headed by
// this default's metadata too.
export const metadata = { description: "Club default" };

export default function ClubDefault() {
  return <p id="intercept-source-group-club-default">Club default</p>;
}
