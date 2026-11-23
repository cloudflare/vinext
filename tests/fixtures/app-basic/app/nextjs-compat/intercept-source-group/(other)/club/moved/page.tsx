// A static page beside `(shared)/club/[slug]`, without its modal slot, that
// middleware rewrites to `/club/acme`, so its public pathname renders a page
// with the slot.
export default function MovedClubPage() {
  return <p id="intercept-source-group-moved">Moved club</p>;
}
