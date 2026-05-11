'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { encrypt } from '@/src/server/crypto';
import {
  DEFAULT_AGENT_TOKEN_DAYS,
  mintAgentToken,
} from '@/src/server/auth/mint-token';
import { db } from '@/src/server/db/index';
import {
  agents,
  tenants,
  tenant_providers,
} from '@/src/server/db/schema';

async function requireSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = await readSessionFromToken(token);
  if (!session) redirect('/login');
  return session;
}

function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

export async function createTenantAction(formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('name is required');

  const baseSlug = slugify(name);
  let slug = baseSlug;
  const existing = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, baseSlug))
    .limit(1);
  if (existing[0]) slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;

  const [inserted] = await db
    .insert(tenants)
    .values({ owner_user_id: session.userId, name, slug })
    .returning({ id: tenants.id });

  redirect(`/dashboard/tenants/${inserted.id}`);
}

export async function createTenantProviderAction(
  tenantId: string,
  formData: FormData,
): Promise<{ secret: string; slug: string }> {
  const session = await requireSession();

  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.owner_user_id, session.userId)))
    .limit(1);
  if (!tenantRows[0]) throw new Error('tenant not found');

  const slug = String(formData.get('slug') ?? '').trim();
  const displayName = String(formData.get('display_name') ?? '').trim();
  const signupUrl = String(formData.get('signup_webhook_url') ?? '').trim();
  const teardownUrl = String(formData.get('teardown_webhook_url') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const docsUrl = String(formData.get('docs_url') ?? '').trim();
  const homepage = String(formData.get('homepage') ?? '').trim();
  const npmPackage = String(formData.get('npm_package') ?? '').trim();
  const categoriesRaw = String(formData.get('categories') ?? '').trim();
  const categories = categoriesRaw
    ? categoriesRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('slug must be [a-z0-9-]+');
  if (!displayName) throw new Error('display_name is required');
  if (!/^https?:\/\//.test(signupUrl)) throw new Error('signup_webhook_url must be http(s)://');
  if (docsUrl && !/^https?:\/\//.test(docsUrl)) throw new Error('docs_url must be http(s)://');
  if (homepage && !/^https?:\/\//.test(homepage)) throw new Error('homepage must be http(s)://');

  const clash = await db
    .select({ id: tenant_providers.id })
    .from(tenant_providers)
    .where(eq(tenant_providers.slug, slug))
    .limit(1);
  if (clash[0]) throw new Error(`slug "${slug}" already taken`);

  const secret = randomBytes(32).toString('base64url');
  await db.insert(tenant_providers).values({
    tenant_id: tenantId,
    slug,
    display_name: displayName,
    signup_webhook_url: signupUrl,
    teardown_webhook_url: teardownUrl || null,
    webhook_secret_enc: encrypt(secret),
    input_schema: {},
    description: description || null,
    docs_url: docsUrl || null,
    homepage: homepage || null,
    npm_package: npmPackage || null,
    categories,
    needs_email_verification: false,
  });

  return { secret, slug };
}

export async function deleteTenantProviderAction(
  tenantId: string,
  providerId: string,
): Promise<void> {
  const session = await requireSession();
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.owner_user_id, session.userId)))
    .limit(1);
  if (!tenantRows[0]) throw new Error('tenant not found');

  await db
    .delete(tenant_providers)
    .where(
      and(
        eq(tenant_providers.id, providerId),
        eq(tenant_providers.tenant_id, tenantId),
      ),
    );
}

export async function mintAgentTokenAction(
  formData: FormData,
): Promise<{ token: string; label: string; expiresAt: string | null }> {
  const session = await requireSession();
  const label =
    String(formData.get('label') ?? '').trim() || `token-${Date.now()}`;

  // Expiry form values:
  //   expiry = '30' | '90' | '365' | 'never'
  //   confirm_never = 'on' — required when expiry === 'never'
  const rawExpiry = String(formData.get('expiry') ?? '30');
  const confirmNever = formData.get('confirm_never') === 'on';

  let expiry: { days: number } | 'never' = { days: DEFAULT_AGENT_TOKEN_DAYS };
  let userRequestedNever = false;
  if (rawExpiry === 'never') {
    if (!confirmNever) {
      throw new Error(
        'Tick the confirmation box to mint a non-expiring token.',
      );
    }
    expiry = 'never';
    userRequestedNever = true;
  } else {
    const days = Number.parseInt(rawExpiry, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      throw new Error('expires_in_days must be between 1 and 365');
    }
    expiry = { days };
  }

  const minted = await mintAgentToken({
    userId: session.userId,
    label,
    scopes: ['*'],
    expiry,
    userRequestedNever,
  });
  return {
    token: minted.token,
    label,
    expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null,
  };
}

export async function revokeAgentTokenAction(tokenId: string): Promise<void> {
  const session = await requireSession();
  await db
    .update(agents)
    .set({ revoked_at: new Date() })
    .where(and(eq(agents.id, tokenId), eq(agents.user_id, session.userId)));
  revalidatePath('/me/agents');
}
