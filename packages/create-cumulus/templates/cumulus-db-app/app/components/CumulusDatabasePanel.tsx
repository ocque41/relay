'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

type DbManifest = {
  id: string;
  ownerAgentId: string;
  humanOwnerEmail: string | null;
  relaySignupId: string | null;
  updatedAt: string;
  recordCount: number;
  lastCompactedAt: string | null;
};

type DbRecord = {
  id: string;
  type: string;
  key?: string;
  title?: string;
  content?: string | null;
  json?: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
  secret: {
    recordIsSecret: boolean;
    fields: string[];
    likelySecretKeys: string[];
    detectorWarnings: string[];
  };
  createdAt: string;
  updatedAt: string;
};

type EnvParse = {
  variables: Array<{
    key: string;
    value: string;
    isLikelySecret: boolean;
    reason: string | null;
  }>;
  warnings: string[];
  invalidLines: Array<{ line: number; reason: string }>;
  duplicateKeys: string[];
  suggestedSecretKeys: string[];
};

type ProviderHealth = {
  ok: boolean;
  service?: string;
};

type McpManifest = {
  name: string;
  tools: string[];
};

type TokenScope =
  | 'records:read'
  | 'records:write'
  | 'search:read'
  | 'events:write'
  | 'kv:read'
  | 'kv:write'
  | 'secrets:write'
  | 'secrets:reveal'
  | 'tokens:manage'
  | 'backups:manage'
  | 'database:admin';

type TokenSummary = {
  id: string;
  label: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type TokenIssue = {
  id: string;
  token: string;
  scopes: TokenScope[];
};

type BackupResult = {
  path: string;
  records: number;
};

type CompactResult = {
  segment: string;
  records: number;
};

const tokenScopes: TokenScope[] = [
  'records:read',
  'records:write',
  'search:read',
  'events:write',
  'kv:read',
  'kv:write',
  'secrets:write',
  'secrets:reveal',
  'tokens:manage',
  'backups:manage',
  'database:admin',
];

const defaultTokenScopes: TokenScope[] = [
  'records:read',
  'records:write',
  'search:read',
  'events:write',
  'kv:read',
  'kv:write',
  'secrets:write',
];

const connectionStorageKey = 'cumulus_db_connection:v1';

async function jsonFetch<T>(url: string, init?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, {
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseOptionalJson(value: string): unknown {
  if (!value.trim()) return undefined;
  return JSON.parse(value);
}

function parseOptionalObject(value: string, label: string): Record<string, unknown> | undefined {
  const parsed = parseOptionalJson(value);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const fieldStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  background: 'transparent',
  color: 'var(--color-ink)',
  padding: '10px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
};

const buttonStyle: CSSProperties = {
  border: '1px solid var(--color-ink)',
  borderRadius: 5.5,
  background: 'var(--color-ink)',
  color: 'var(--color-paper)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '10px 14px',
  textTransform: 'uppercase',
};

const quietButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'transparent',
  color: 'var(--color-ink)',
};

const cardStyle: CSSProperties = {
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  display: 'grid',
  gap: 12,
  padding: 16,
};

const labelStyle: CSSProperties = {
  color: 'var(--color-ink-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  margin: 0,
  textTransform: 'uppercase',
};

const proseStyle: CSSProperties = {
  color: 'var(--color-ink-2)',
  fontSize: 13,
  lineHeight: 1.55,
  margin: 0,
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
};

export function CumulusDatabasePanel() {
  const [databaseId, setDatabaseId] = useState('');
  const [token, setToken] = useState('');
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [manifest, setManifest] = useState<DbManifest | null>(null);
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [mcpManifest, setMcpManifest] = useState<McpManifest | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [secretRecord, setSecretRecord] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DbRecord[]>([]);
  const [recordView, setRecordView] = useState<'detailed' | 'compact'>('detailed');
  const [envText, setEnvText] = useState('');
  const [envParse, setEnvParse] = useState<EnvParse | null>(null);
  const [kvKey, setKvKey] = useState('');
  const [kvValue, setKvValue] = useState('{"status":"ok"}');
  const [kvMetadata, setKvMetadata] = useState('{"source":"dashboard"}');
  const [kvResult, setKvResult] = useState<DbRecord | null>(null);
  const [eventTitle, setEventTitle] = useState('Agent event');
  const [eventContent, setEventContent] = useState('Event written from the dashboard.');
  const [eventJson, setEventJson] = useState('{"source":"dashboard"}');
  const [eventTags, setEventTags] = useState('event,dashboard');
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [tokenLabel, setTokenLabel] = useState('Dashboard token');
  const [selectedScopes, setSelectedScopes] = useState<TokenScope[]>(defaultTokenScopes);
  const [issuedToken, setIssuedToken] = useState<TokenIssue | null>(null);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResult | null>(null);
  const [revealed, setRevealed] = useState<{ field: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(connectionStorageKey);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { databaseId?: string };
      if (saved.databaseId) setDatabaseId(saved.databaseId);
    } catch {
      window.localStorage.removeItem(connectionStorageKey);
    }
  }, []);

  const canUseDatabase = useMemo(
    () => databaseId.trim().length > 0 && token.trim().length > 0,
    [databaseId, token],
  );

  const kvRecords = useMemo(() => records.filter((record) => record.type === 'kv'), [records]);
  const eventRecords = useMemo(() => records.filter((record) => record.type === 'event'), [records]);

  const loadProviderMetadata = useCallback(async () => {
    try {
      setHealth(await jsonFetch<ProviderHealth>('/api/cumulus-db/health'));
    } catch (err) {
      setHealth({ ok: false, service: err instanceof Error ? err.message : String(err) });
    }

    try {
      setMcpManifest(await jsonFetch<McpManifest>('/api/cumulus-db/mcp'));
    } catch {
      setMcpManifest(null);
    }
  }, []);

  useEffect(() => {
    void loadProviderMetadata();
  }, [loadProviderMetadata]);

  const loadRecords = useCallback(async () => {
    if (!canUseDatabase) return;
    setBusy(true);
    setError(null);
    try {
      const id = databaseId.trim();
      const scopedToken = token.trim();
      window.localStorage.setItem(connectionStorageKey, JSON.stringify({ databaseId: id }));
      const body = await jsonFetch<{ database: DbManifest; records: DbRecord[] }>(
        `/api/cumulus-db/databases/${encodeURIComponent(id)}`,
        undefined,
        scopedToken,
      );
      setManifest(body.database);
      setRecords(body.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [canUseDatabase, databaseId, token]);

  const loadTokens = useCallback(async () => {
    if (!canUseDatabase) return;
    setTokenError(null);
    try {
      const body = await jsonFetch<{ tokens: TokenSummary[] }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/tokens`,
        undefined,
        token.trim(),
      );
      setTokens(body.tokens);
    } catch (err) {
      setTokens([]);
      setTokenError(err instanceof Error ? err.message : String(err));
    }
  }, [canUseDatabase, databaseId, token]);

  async function createRecord() {
    if (!canUseDatabase || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jsonFetch(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/records`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: secretRecord ? 'secret' : 'note',
            title: title.trim() || undefined,
            content,
            recordIsSecret: secretRecord,
            tags: secretRecord ? ['secret'] : ['manual'],
          }),
        },
        token.trim(),
      );
      setTitle('');
      setContent('');
      setSecretRecord(false);
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!canUseDatabase) return;
    setError(null);
    try {
      const body = await jsonFetch<{ hits: Array<{ record: DbRecord }> }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/search`,
        {
          method: 'POST',
          body: JSON.stringify({ query, limit: 12 }),
        },
        token.trim(),
      );
      setResults(body.hits.map((hit) => hit.record));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function parseEnv() {
    setError(null);
    try {
      const body = await jsonFetch<EnvParse>('/api/cumulus-db/env/parse', {
        method: 'POST',
        body: JSON.stringify({ content: envText }),
      });
      setEnvParse(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveEnvRecord() {
    if (!canUseDatabase || !envParse) return;
    const secrets = Object.fromEntries(
      envParse.variables
        .filter((item) => item.isLikelySecret)
        .map((item) => [item.key, item.value]),
    );
    const publicVars = Object.fromEntries(
      envParse.variables
        .filter((item) => !item.isLikelySecret)
        .map((item) => [item.key, item.value]),
    );
    await jsonFetch(
      `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/records`,
      {
        method: 'POST',
        body: JSON.stringify({
          type: Object.keys(secrets).length ? 'secret' : 'document',
          title: 'Environment variables',
          json: publicVars,
          secrets,
          tags: ['env'],
        }),
      },
      token.trim(),
    );
    setEnvText('');
    setEnvParse(null);
    await loadRecords();
  }

  async function revealSecret(recordId: string, field: string) {
    if (!canUseDatabase) return;
    setError(null);
    try {
      const body = await jsonFetch<{ secret: { field: string; value: string } }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/secrets/reveal`,
        {
          method: 'POST',
          body: JSON.stringify({ recordId, field }),
        },
        token.trim(),
      );
      setRevealed(body.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function putKv() {
    if (!canUseDatabase || !kvKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const value = parseOptionalJson(kvValue);
      if (value === undefined) throw new Error('KV value is required.');
      const metadata = parseOptionalObject(kvMetadata, 'KV metadata');
      const body = await jsonFetch<{ record: DbRecord }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/kv/${encodeURIComponent(kvKey.trim())}`,
        {
          method: 'PUT',
          body: JSON.stringify({ value, metadata }),
        },
        token.trim(),
      );
      setKvResult(body.record);
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function getKv() {
    if (!canUseDatabase || !kvKey.trim()) return;
    setError(null);
    try {
      const body = await jsonFetch<{ record: DbRecord }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/kv/${encodeURIComponent(kvKey.trim())}`,
        undefined,
        token.trim(),
      );
      setKvResult(body.record);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function appendEvent() {
    if (!canUseDatabase) return;
    setBusy(true);
    setError(null);
    try {
      await jsonFetch(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/events`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'event',
            title: eventTitle || undefined,
            content: eventContent || undefined,
            json: parseOptionalJson(eventJson),
            tags: splitCsv(eventTags),
          }),
        },
        token.trim(),
      );
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleScope(scope: TokenScope) {
    setSelectedScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }

  async function createToken() {
    if (!canUseDatabase || selectedScopes.length === 0) return;
    setBusy(true);
    setTokenError(null);
    setIssuedToken(null);
    try {
      const body = await jsonFetch<{ token: TokenIssue }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/tokens`,
        {
          method: 'POST',
          body: JSON.stringify({ label: tokenLabel || 'Dashboard token', scopes: selectedScopes }),
        },
        token.trim(),
      );
      setIssuedToken(body.token);
      await loadTokens();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotateToken(tokenId: string) {
    if (!canUseDatabase) return;
    setBusy(true);
    setTokenError(null);
    setIssuedToken(null);
    try {
      const body = await jsonFetch<{ token: TokenIssue }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/tokens/${encodeURIComponent(tokenId)}/rotate`,
        { method: 'POST' },
        token.trim(),
      );
      setIssuedToken(body.token);
      await loadTokens();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(tokenId: string) {
    if (!canUseDatabase) return;
    setBusy(true);
    setTokenError(null);
    try {
      await jsonFetch(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/tokens/${encodeURIComponent(tokenId)}`,
        { method: 'DELETE' },
        token.trim(),
      );
      await loadTokens();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createBackup() {
    if (!canUseDatabase) return;
    setBusy(true);
    setError(null);
    try {
      const body = await jsonFetch<{ backup: BackupResult }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/backups`,
        { method: 'POST' },
        token.trim(),
      );
      setBackupResult(body.backup);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function compactDatabase() {
    if (!canUseDatabase) return;
    setBusy(true);
    setError(null);
    try {
      const body = await jsonFetch<{ compaction: CompactResult }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/compact`,
        { method: 'POST' },
        token.trim(),
      );
      setCompactResult(body.compaction);
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const displayedRecords = results.length > 0 ? results : records;

  return (
    <div style={{ display: 'grid', gap: 28, maxWidth: 1120 }}>
      <section style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div style={cardStyle}>
          <p style={labelStyle}>Provider health</p>
          <p style={proseStyle}>
            {health
              ? `${health.service ?? 'cumulus-db'}: ${health.ok ? 'healthy' : 'unhealthy'}`
              : 'No health response yet.'}
          </p>
          <button type="button" onClick={loadProviderMetadata} style={quietButtonStyle}>
            Check
          </button>
        </div>
        <div style={cardStyle}>
          <p style={labelStyle}>MCP metadata</p>
          <p style={proseStyle}>{mcpManifest ? mcpManifest.name : 'No MCP metadata yet.'}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {mcpManifest?.tools.map((tool) => (
              <code key={tool} style={{ ...monoStyle, border: '1px solid var(--color-hair)', borderRadius: 999, padding: '3px 7px' }}>
                {tool}
              </code>
            ))}
          </div>
        </div>
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void loadRecords();
        }}
        style={cardStyle}
      >
        <p style={labelStyle}>Connection</p>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <input
            value={databaseId}
            onChange={(event) => setDatabaseId(event.target.value)}
            placeholder="Database id"
            style={fieldStyle}
          />
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Scoped token"
            type="password"
            style={fieldStyle}
          />
          <button type="submit" disabled={!canUseDatabase || busy} style={buttonStyle}>
            Connect
          </button>
        </div>
        <p style={proseStyle}>
          Data tokens can read and write normal records. Secret reveal, token management, backup, and compact require an admin token or matching scopes.
        </p>
        {manifest ? (
          <p style={proseStyle}>
            Connected to <code>{manifest.id}</code>. Records: {records.length}. Last compacted:{' '}
            {manifest.lastCompactedAt ?? 'never'}.
          </p>
        ) : null}
        {error ? <p style={{ ...proseStyle, color: 'var(--color-terracotta)' }}>{error}</p> : null}
      </form>

      <section style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Records</h2>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" style={fieldStyle} />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Content"
            rows={4}
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
          <label style={{ alignItems: 'center', display: 'inline-flex', gap: 8, fontSize: 13 }}>
            <input checked={secretRecord} onChange={(event) => setSecretRecord(event.target.checked)} type="checkbox" />
            Store as secret
          </label>
          <button type="button" onClick={createRecord} disabled={!canUseDatabase || !content.trim() || busy} style={buttonStyle}>
            Add record
          </button>
        </div>

        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Search</h2>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search query" style={fieldStyle} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={runSearch} disabled={!canUseDatabase} style={buttonStyle}>
              Search
            </button>
            <button type="button" onClick={() => setResults([])} style={quietButtonStyle}>
              Clear
            </button>
          </div>
          <p style={proseStyle}>{results.length ? `${results.length} search result(s)` : `${records.length} stored record(s)`}</p>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Key-value</h2>
          <input value={kvKey} onChange={(event) => setKvKey(event.target.value)} placeholder="KV key" style={fieldStyle} />
          <textarea value={kvValue} onChange={(event) => setKvValue(event.target.value)} rows={4} style={{ ...fieldStyle, resize: 'vertical' }} />
          <textarea value={kvMetadata} onChange={(event) => setKvMetadata(event.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={getKv} disabled={!canUseDatabase || !kvKey.trim()} style={quietButtonStyle}>
              Read
            </button>
            <button type="button" onClick={putKv} disabled={!canUseDatabase || !kvKey.trim() || busy} style={buttonStyle}>
              Write
            </button>
          </div>
          {kvResult ? <pre style={{ ...fieldStyle, overflowX: 'auto' }}>{formatJson(kvResult.json)}</pre> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {kvRecords.slice(0, 10).map((record) => (
              <button key={record.id} type="button" onClick={() => setKvKey(record.key ?? '')} style={quietButtonStyle}>
                {record.key ?? record.id}
              </button>
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Events</h2>
          <input value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} placeholder="Event title" style={fieldStyle} />
          <textarea value={eventContent} onChange={(event) => setEventContent(event.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical' }} />
          <textarea value={eventJson} onChange={(event) => setEventJson(event.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical' }} />
          <input value={eventTags} onChange={(event) => setEventTags(event.target.value)} placeholder="Tags" style={fieldStyle} />
          <button type="button" onClick={appendEvent} disabled={!canUseDatabase || busy} style={buttonStyle}>
            Append event
          </button>
          {eventRecords.slice(0, 5).map((record) => (
            <p key={record.id} style={proseStyle}>
              <strong>{record.title ?? record.id}</strong>: {record.content ?? '[no content]'}
            </p>
          ))}
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Environment</h2>
        <textarea
          value={envText}
          onChange={(event) => setEnvText(event.target.value)}
          placeholder="KEY=value"
          rows={5}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={parseEnv} disabled={!envText.trim()} style={buttonStyle}>
            Parse env
          </button>
          <button type="button" onClick={saveEnvRecord} disabled={!canUseDatabase || !envParse} style={quietButtonStyle}>
            Save env record
          </button>
        </div>
        {envParse ? (
          <p style={proseStyle}>
            Parsed {envParse.variables.length} variable(s). Secrets:{' '}
            {envParse.variables.filter((item) => item.isLikelySecret).length}.
          </p>
        ) : null}
      </section>

      <section style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Token management</h2>
          <button type="button" onClick={loadTokens} disabled={!canUseDatabase || busy} style={quietButtonStyle}>
            Load tokens
          </button>
        </div>
        <p style={proseStyle}>Requires a token with token management scope. Newly issued token values are shown once.</p>
        {tokenError ? <p style={{ ...proseStyle, color: 'var(--color-terracotta)' }}>{tokenError}</p> : null}
        {issuedToken ? <pre style={{ ...fieldStyle, overflowX: 'auto' }}>{issuedToken.token}</pre> : null}
        <input value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} placeholder="Token label" style={fieldStyle} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {tokenScopes.map((scope) => (
            <label key={scope} style={{ ...monoStyle, alignItems: 'center', display: 'inline-flex', gap: 6 }}>
              <input
                type="checkbox"
                checked={selectedScopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              {scope}
            </label>
          ))}
        </div>
        <button type="button" onClick={createToken} disabled={!canUseDatabase || !selectedScopes.length || busy} style={buttonStyle}>
          Create token
        </button>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 720, width: '100%' }}>
            <thead>
              <tr>
                {['Label', 'Scopes', 'Last used', 'Status', 'Actions'].map((heading) => (
                  <th key={heading} style={{ ...labelStyle, borderBottom: '1px solid var(--color-hair)', padding: '8px 6px', textAlign: 'left' }}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((item) => (
                <tr key={item.id}>
                  <td style={{ ...monoStyle, borderBottom: '1px solid var(--color-hair)', padding: '8px 6px' }}>{item.label}</td>
                  <td style={{ ...monoStyle, borderBottom: '1px solid var(--color-hair)', padding: '8px 6px' }}>{item.scopes.join(', ')}</td>
                  <td style={{ ...monoStyle, borderBottom: '1px solid var(--color-hair)', padding: '8px 6px' }}>{item.lastUsedAt ?? 'never'}</td>
                  <td style={{ borderBottom: '1px solid var(--color-hair)', padding: '8px 6px' }}>{item.revokedAt ? 'revoked' : 'active'}</td>
                  <td style={{ borderBottom: '1px solid var(--color-hair)', padding: '8px 6px' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={() => rotateToken(item.id)} disabled={busy || Boolean(item.revokedAt)} style={quietButtonStyle}>
                        Rotate
                      </button>
                      <button type="button" onClick={() => revokeToken(item.id)} disabled={busy || Boolean(item.revokedAt)} style={quietButtonStyle}>
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Backup and compact</h2>
        <p style={proseStyle}>Requires backup management scope. Backups snapshot records and tokens; compaction rewrites the active segment.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={createBackup} disabled={!canUseDatabase || busy} style={buttonStyle}>
            Backup
          </button>
          <button type="button" onClick={compactDatabase} disabled={!canUseDatabase || busy} style={quietButtonStyle}>
            Compact
          </button>
        </div>
        <p style={proseStyle}>Backup: {backupResult ? `${backupResult.records} records at ${backupResult.path}` : 'none this session'}</p>
        <p style={proseStyle}>Compact: {compactResult ? `${compactResult.records} records in ${compactResult.segment}` : 'none this session'}</p>
      </section>

      <section style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>{results.length ? 'Search results' : 'Stored records'}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['detailed', 'compact'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRecordView(mode)}
                style={recordView === mode ? buttonStyle : quietButtonStyle}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {displayedRecords.slice(0, 24).map((record) =>
            recordView === 'compact' ? (
              <article
                key={record.id}
                style={{
                  alignItems: 'center',
                  border: '1px solid var(--color-hair)',
                  borderRadius: 5.5,
                  display: 'grid',
                  gap: 10,
                  gridTemplateColumns: '100px minmax(0, 1fr) auto',
                  padding: 10,
                }}
              >
                <code style={monoStyle}>{record.type}</code>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {record.title ?? record.key ?? record.id}
                </span>
                {record.secret.fields[0] ? (
                  <button type="button" onClick={() => revealSecret(record.id, record.secret.fields[0]!)} style={quietButtonStyle}>
                    Reveal
                  </button>
                ) : null}
              </article>
            ) : (
              <article key={record.id} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <b style={{ color: 'var(--color-ink)' }}>{record.title || record.key || record.type}</b>
                  <code style={monoStyle}>{record.type}</code>
                </div>
                <p style={proseStyle}>{record.content ?? '[no content]'}</p>
                {record.json !== undefined ? <pre style={{ ...fieldStyle, overflowX: 'auto' }}>{formatJson(record.json)}</pre> : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {record.secret.fields.map((field) => (
                    <button key={field} type="button" onClick={() => revealSecret(record.id, field)} style={quietButtonStyle}>
                      Reveal {field}
                    </button>
                  ))}
                </div>
              </article>
            ),
          )}
        </div>
      </section>

      {revealed ? (
        <section style={cardStyle}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Revealed secret</h2>
          <pre style={{ ...fieldStyle, overflowX: 'auto' }}>{`${revealed.field}=${revealed.value}`}</pre>
        </section>
      ) : null}
    </div>
  );
}
