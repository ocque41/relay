'use client';

import { useState, useTransition } from 'react';
import { saveAgentGuideAction, MAX_GUIDE_BYTES } from './actions';

interface Props {
  initialContent: string;
  updatedAt: string | null;
}

export default function AgentGuideEditor({ initialContent, updatedAt }: Props) {
  const [content, setContent] = useState(initialContent);
  const [pending, startTransition] = useTransition();

  const bytes = new TextEncoder().encode(content).byteLength;
  const over = bytes > MAX_GUIDE_BYTES;
  const pct = Math.min(100, (bytes / MAX_GUIDE_BYTES) * 100);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (over) return;
    const form = new FormData(e.currentTarget);
    startTransition(async () => {
      await saveAgentGuideAction(form);
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <textarea
        name="content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={20}
        style={{
          width: '100%',
          padding: 12,
          background: 'var(--color-paper)',
          border: '1px solid var(--color-hair)',
          borderRadius: 5.5,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--color-ink)',
          resize: 'vertical',
        }}
        placeholder={`# My defaults

When I ask you to create a Vercel project,
default the label to \`cumulush-<timestamp>\`.

# My stack
- Neon Postgres in us-east-2
- Resend for transactional mail`}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.06em',
          color: over ? 'crimson' : 'var(--color-ink-3)',
          textTransform: 'uppercase',
        }}
      >
        <span>
          {bytes.toLocaleString()} / {MAX_GUIDE_BYTES.toLocaleString()} bytes
        </span>
        <span
          aria-hidden
          style={{
            flex: 1,
            height: 2,
            background: 'var(--color-hair)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              position: 'absolute',
              inset: 0,
              width: `${pct}%`,
              background: over ? 'crimson' : 'var(--color-ink)',
            }}
          />
        </span>
        {updatedAt && (
          <span>
            saved {new Date(updatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          type="submit"
          disabled={pending || over}
          style={{
            padding: '8px 14px',
            background: over ? 'var(--color-hair)' : 'var(--color-ink)',
            color: 'var(--color-paper)',
            border: 0,
            borderRadius: 5.5,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            cursor: over || pending ? 'not-allowed' : 'pointer',
            opacity: pending ? 0.7 : 1,
          }}
        >
          {pending ? 'Saving…' : over ? 'Too large' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setContent(initialContent)}
          disabled={pending || content === initialContent}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 0,
            cursor: pending || content === initialContent ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-ink-3)',
            padding: 0,
            opacity: content === initialContent ? 0.4 : 1,
          }}
        >
          Revert →
        </button>
      </div>
    </form>
  );
}
