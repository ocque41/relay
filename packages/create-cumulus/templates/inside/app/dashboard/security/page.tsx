import { redirect } from 'next/navigation';

export default function LegacySecurityRedirect() {
  redirect('/me/security');
}
