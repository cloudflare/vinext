'use client';

import {ComponentProps} from 'react';
import {Link} from '@/i18n/navigation';

export default function NavigationLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} />;
}
