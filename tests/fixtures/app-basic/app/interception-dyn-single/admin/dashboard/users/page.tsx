import Link from "next/link";

export default function UsersPage() {
  return (
    <div>
      <div id="users-page">Admin Dashboard - Users</div>
      <Link href="/interception-dyn-single/admin/dashboard/users/new" id="new-user-link">
        New User
      </Link>
    </div>
  );
}
