/**
 * Legacy /dashboard layout. The dashboard has been split into two workspaces
 * (/me for end-users, /dev for developers). The layout itself no longer
 * renders UI; individual /dashboard/* pages redirect to their new homes so
 * bookmarked links keep working.
 */
export default function LegacyDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
