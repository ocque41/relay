/**
 * MCP smoke: hits /mcp with a JSON-RPC tools/call for resolve_intent and
 * asserts the trimmed response shape (no revealUrl, no revealAllUrl).
 */
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';
import { mintAgentToken } from '../src/server/auth/mint-token';

const BASE_URL = process.env.HTTP_SMOKE_BASE ?? 'http://localhost:3000';

function pass(name: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function fail(name: string, detail: string): never {
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
  process.exit(1);
}

async function callTool(token: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'resolve_intent',
        arguments: { agent_token: token, ...args },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    fail('mcp call', `status=${res.status} body=${text.slice(0, 200)}`);
  }
  const body = await res.text();
  // Streamable transport returns either application/json or SSE. Parse the
  // first JSON object regardless.
  const jsonStart = body.indexOf('{');
  const parsed = JSON.parse(body.slice(jsonStart));
  return parsed as {
    result?: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    error?: unknown;
  };
}

async function main() {
  console.log(`[setup] MCP smoke against ${BASE_URL}/mcp`);

  const r = await db.execute(sql`
    SELECT u.id AS user_id, w.id AS workspace_id
    FROM users u
    JOIN user_workspaces w ON w.user_id = u.id
    LIMIT 1
  `);
  if (r.rows.length === 0) fail('setup', 'no user+workspace');
  const { user_id: userId, workspace_id: workspaceId } = r.rows[0] as {
    user_id: string;
    workspace_id: string;
  };

  const minted = await mintAgentToken({
    userId,
    userWorkspaceId: workspaceId,
    label: 'smoke-mcp',
    scopes: [],
    expiry: { days: 1 },
  });
  console.log(`[setup]   agent=${minted.agentId.slice(0, 8)}`);

  const reply = await callTool(minted.token, {
    goal: 'postgres for next.js',
    workspace_id: workspaceId,
  });

  if (reply.error) fail('rpc returned no error', JSON.stringify(reply.error));
  if (!reply.result) fail('rpc returned a result', JSON.stringify(reply));
  if (reply.result.isError) {
    fail(
      'tool call succeeded',
      reply.result.content.map((c) => c.text).join('\n'),
    );
  }
  pass('resolve_intent returned without isError');

  const text = reply.result.content[0]?.text ?? '';
  const payload = JSON.parse(text) as {
    resolutions: Array<{
      category: string;
      provider: string;
      status: string;
      revealUrl?: string;
    }>;
    revealAllUrl?: unknown;
    envBlock: string;
  };

  const dbRes = payload.resolutions.find((x) => x.category === 'database');
  if (!dbRes) fail('database resolution exists', text);
  if (dbRes.provider !== 'neon') fail('database → neon', `got ${dbRes.provider}`);
  pass(`database resolution → neon (${dbRes.status})`);

  // Per the design contract, MCP variant strips revealUrl + revealAllUrl
  // so LLMs can't speculatively call them.
  for (const res of payload.resolutions) {
    if ('revealUrl' in res && res.revealUrl !== undefined) {
      fail(
        'MCP variant strips revealUrl',
        `resolution ${res.category}/${res.provider} carried revealUrl=${res.revealUrl}`,
      );
    }
  }
  pass('MCP response strips per-resolution revealUrl');

  if ('revealAllUrl' in payload && payload.revealAllUrl !== undefined) {
    fail('MCP response strips revealAllUrl', JSON.stringify(payload));
  }
  pass('MCP response strips revealAllUrl');

  // Cleanup
  await db.execute(sql`UPDATE agents SET revoked_at = NOW() WHERE id = ${minted.agentId}`);
  await db.execute(sql`DELETE FROM signup_jobs WHERE calling_agent_id = ${minted.agentId}`);

  console.log('\n\x1b[32mall MCP smoke checks passed.\x1b[0m');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n\x1b[31mMCP smoke failed:\x1b[0m', e);
    process.exit(1);
  });
