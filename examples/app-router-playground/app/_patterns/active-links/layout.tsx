import { NavLinks } from '#/app/_patterns/active-links/_components/nav-links';
import Image from 'next/image';
import Link from 'next/link';

export default function Layout({ children }: { children: React.ReactNode }) {
  // Hardcoded links or fetched from db
  const links = [
    { href: '/patterns/active-links', name: 'Home' },
    { href: '/patterns/active-links/profile', name: 'Profile' },
    { href: '/patterns/active-links/community', name: 'Community' },
    { href: '/patterns/active-links/settings', name: 'Settings' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-x-3 py-3">
        <NavLinks links={links} />
        <Link href="/active-links/profile">
          <Image
            src="/prince-akachi-LWkFHEGpleE-unsplash.jpg"
            className="rounded-full"
            width={40}
            height={40}
            alt="User"
          />
        </Link>
      </div>
      <main>{children}</main>
    </div>
  );
}
