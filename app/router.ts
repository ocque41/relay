/**
 * Static URL constants. Single source of truth for every nav item +
 * every palette destination.
 */

export interface NavItem {
  href: string;
  label: string;
}

export const USER_NAV: NavItem[] = [
  { href: '/me',          label: 'Overview' },
  { href: '/me/accounts', label: 'Accounts' },
  { href: '/me/signups',  label: 'Signups'  },
  { href: '/me/keys',     label: 'Keys'     },
  { href: '/me/inbox',    label: 'Inbox'    },
  { href: '/me/agents',   label: 'Agents'   },
  { href: '/me/share',    label: 'Share'    },
  { href: '/me/agent-guide', label: 'Guide' },
  { href: '/me/security', label: 'Security' },
  { href: '/docs/user',   label: 'Docs'     },
];

export const DEV_NAV: NavItem[] = [
  { href: '/dev',            label: 'Overview'  },
  { href: '/dev/products',   label: 'Products'  },
  { href: '/dev/users',      label: 'Users'     },
  { href: '/dev/team',       label: 'Team'      },
  { href: '/dev/billing',    label: 'Billing'   },
  { href: '/dev/analytics',  label: 'Analytics' },
  { href: '/dev/settings',   label: 'Settings'  },
  { href: '/dev/audit-log',  label: 'Audit log' },
  { href: '/docs/developer', label: 'Docs'      },
];

/** Zero-pad to `01..09`, `10`+ unchanged. */
export function navNumber(index: number): string {
  const n = index + 1;
  return n < 10 ? `0${n}` : String(n);
}

/** Match the best nav item for a given path (longest-prefix wins). */
export function activeNavHref(nav: NavItem[], pathname: string): string | null {
  let best: { href: string; len: number } | null = null;
  for (const item of nav) {
    if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (!best || item.href.length > best.len) {
        best = { href: item.href, len: item.href.length };
      }
    }
  }
  return best?.href ?? null;
}
