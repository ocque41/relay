/**
 * Public, unauthenticated manifest endpoints for AI agents.
 *
 *   GET /AGENTS.md       → markdown operating guide
 *   GET /CLAUDE.md       → alias of /AGENTS.md (for tooling that looks for this name)
 *   GET /llms.txt        → short llmstxt.org index
 *   GET /llms-full.txt   → full agent guide, plain text
 *
 * Optional bearer auth: when a valid token is present, /AGENTS.md and
 * /llms-full.txt append a pointer to the caller's /v1/agent-guide so the
 * agent knows to fetch per-user memory. Unauth'd fetches get a static
 * "sign in for per-user guidance" note instead.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppEnv } from '../auth';
import { hashToken } from '../crypto';
import { db } from '../db/index';
import { agents, users } from '../db/schema';
import {
  renderAgentsMarkdown,
  renderLlmsFullTxt,
  renderLlmsTxt,
  type ManifestContext,
} from '../agents-manifest/content';

const app = new Hono<AppEnv>();

function apiBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodHost) return `https://${prodHost.replace(/^https?:\/\//, '')}`;
  return 'http://localhost:3000';
}

async function optionalAuthUserGuideUpdatedAt(
  authHeader: string | undefined,
): Promise<string | null | undefined> {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice(7).trim();
  if (!token) return undefined;
  try {
    const [agent] = await db
      .select({ user_id: agents.user_id })
      .from(agents)
      .where(and(eq(agents.token_hash, hashToken(token)), isNull(agents.revoked_at)))
      .limit(1);
    if (!agent?.user_id) return undefined;
    const [row] = await db
      .select({ agent_guide_updated_at: users.agent_guide_updated_at })
      .from(users)
      .where(eq(users.id, agent.user_id))
      .limit(1);
    return row?.agent_guide_updated_at
      ? new Date(row.agent_guide_updated_at).toISOString()
      : null;
  } catch {
    return undefined;
  }
}

async function buildContext(c: Context<AppEnv>): Promise<ManifestContext> {
  const baseUrl = apiBaseUrl();
  const updatedAt = await optionalAuthUserGuideUpdatedAt(c.req.header('Authorization'));
  return {
    baseUrl,
    ...(updatedAt !== undefined ? { authenticatedUserGuideHint: { updatedAt } } : {}),
  };
}

app.get('/AGENTS.md', async (c) => {
  const ctx = await buildContext(c);
  return c.text(renderAgentsMarkdown(ctx), 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

app.get('/CLAUDE.md', async (c) => {
  const ctx = await buildContext(c);
  return c.text(renderAgentsMarkdown(ctx), 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

app.get('/llms.txt', async (c) => {
  const ctx = await buildContext(c);
  return c.text(renderLlmsTxt(ctx), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

app.get('/llms-full.txt', async (c) => {
  const ctx = await buildContext(c);
  return c.text(renderLlmsFullTxt(ctx), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

export default app;
