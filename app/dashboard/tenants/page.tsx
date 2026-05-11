import { redirect } from 'next/navigation';

export default function LegacyTenantsRedirect() {
  redirect('/dev/products');
}
