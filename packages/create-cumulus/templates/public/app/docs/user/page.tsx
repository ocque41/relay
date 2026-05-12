import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';
import { Row } from '@/app/components/Row';

const inlineCode = {
  padding: '1px 5px',
  background: 'var(--color-wash)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
};

export default function UserDocs() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '96px 24px 96px',
        display: 'grid',
        gap: 48,
      }}
    >
      <Link
        href="/docs"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--color-ink-3)',
        }}
      >
        ← Docs
      </Link>
      <header>
        <Kicker>End user</Kicker>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 300,
            fontSize: 60,
            lineHeight: 0.95,
            letterSpacing: '-0.035em',
            margin: 0,
          }}
        >
          User docs.
        </h1>
        <p
          style={{
            marginTop: 20,
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            color: 'var(--color-ink-2)',
            lineHeight: 1.6,
            maxWidth: 540,
          }}
        >
          Relay is the service your AI agent uses to sign you up for things.
          This page explains what Relay does with your data and how to use it.
        </p>
      </header>

      <Row label="What Relay is">
        When you ask your agent to &quot;sign me up for X&quot;, the agent calls
        Relay. Relay talks to X on your behalf, reads any verification emails,
        and hands the resulting account and API key back to the agent so it can
        finish the task. You get an overview of everything at{' '}
        <Link href="/me">/me</Link>.
      </Row>

      <Row label="Your agent picks the best service">
        You don&apos;t need to tell your agent <em>which</em> provider to use.
        Relay ships a category-aware provider catalog (databases, hosting,
        email, newsletters, auth, storage, analytics, payments, and more).
        When you say <em>&quot;I need a database for my app&quot;</em>, your
        agent fetches just the <code style={inlineCode}>database</code> slice,
        compares the options on pricing and capabilities, picks one that fits,
        and signs you up. Nothing for you to configure.
      </Row>

      <Row label="Multiple personal workspaces">
        Keep different projects separated inside the same account. Each
        workspace you create is its own private space — its own accounts,
        API keys, inbox, and agent tokens. Nothing from workspace <b>Acme</b>
        bleeds into workspace <b>Personal</b>.
        <br />
        <br />
        Create, switch, rename, and delete workspaces at{' '}
        <Link href="/me/workspaces">/me/workspaces</Link>, or use the
        workspace switcher in the top nav for quick switches. Your default
        workspace is called <b>Default</b> and can&apos;t be deleted — rename
        it or make another workspace your new primary at any time.
        <br />
        <br />
        Agent tokens you mint in one workspace <b>only</b> see that
        workspace. A token from <b>Acme</b> calling{' '}
        <code style={inlineCode}>/v1/user/accounts</code> returns Acme
        accounts, never Personal ones. This is the same rule whether the
        agent calls the REST API or MCP.
      </Row>

      <Row label="The agent inbox">
        Every Relay user gets a dedicated email address like{' '}
        <code style={inlineCode}>yourname-abc1@inbox.cumulush.com</code>. Agents
        use this address whenever they sign you up somewhere — it lets them
        read verification codes without you copy-pasting.
        <br />
        See every email at <Link href="/me/inbox">/me/inbox</Link>.
      </Row>

      <Row label="Agent tokens">
        An agent token is a password-like string that lets a single agent
        (e.g. your Claude Desktop) act on your behalf. Create and revoke them
        at <Link href="/me/agents">/me/agents</Link>. Only you and the agent
        ever see the value — Relay stores only its hash.
        <br />
        <br />
        <b>Expiry.</b> New tokens rotate after 30 days by default — if a
        token is ever copied from a disk image or checked into a git repo by
        accident, it stops working on its own. When an agent mints a token
        on your behalf it should write it to your project&apos;s
        <code style={inlineCode}>CLAUDE.md</code> under a{' '}
        <code style={inlineCode}>## Relay</code> heading together with the
        expiry date. Your next AI session will pick the same token up and
        reuse it. When it expires, the next call to Relay returns a clear
        error and your agent will ask you to re-run the signup flow.
        <br />
        <br />
        You can pick 30 days, 90 days, 1 year, or &quot;never&quot; when
        minting from the dashboard or approving a CLI login. &quot;Never&quot;
        requires an explicit confirmation — if a leaked forever-token is
        worse for you than re-approving a CLI once a month, leave the
        default.
      </Row>

      <Row label="API keys">
        When your agent signs you up somewhere (say, Neon), that service issues
        an API key. Relay hands the plaintext to your agent in your chat
        session and then <strong>forgets</strong> it. What Relay keeps is a
        bookkeeping row — label, timestamps, and a reference your agent can
        use to revoke it later — but not the key bytes.
        <br />
        See bookkeeping rows at <Link href="/me/keys">/me/keys</Link>.
      </Row>

      <Row label="Magic-link sharing">
        When you&apos;re away from a computer but want a quick glance at what
        your agent did, mint a share link at{' '}
        <Link href="/me/share">/me/share</Link>. The URL opens a minimal
        read-only summary (account count, recent signups, aliases) without
        requiring login. Default: single-use, 10-minute TTL.
      </Row>

      <Row label="Dashboard">
        Use <Link href="/me">/me</Link> as the first-class agent account
        surface:
        <br />
        <Link href="/me/accounts">/me/accounts</Link> — third-party accounts
        <br />
        <Link href="/me/keys">/me/keys</Link> — bookkeeping for every key
        <br />
        <Link href="/me/signups">/me/signups</Link> — timeline of agent signups
        <br />
        <code style={inlineCode}>relay inbox</code> — recent verification emails
        <br />
        <code style={inlineCode}>relay share</code> — mint a read-only share link
        <br />
        <code style={inlineCode}>relay workspaces</code> — list / create / rename / delete your personal workspaces
        <br />
        <code style={inlineCode}>relay whoami</code> — show who you are + which
        workspace your CLI token is pinned to
      </Row>

      <Row label="Privacy">
        Relay scopes every piece of data to your user id. Other users&apos;
        agents cannot see your accounts, keys, inbox, or audit log. Staff can
        see your email (it&apos;s how you log in). Staff cannot see your agent
        tokens, API keys, or account contents — those are either hashed,
        not-stored-at-all, or encrypted with a key scoped to your
        session/account.
      </Row>

      <Row label="Cost to you">
        Free. Always. The integrator that built the app you&apos;re
        using is the one paying Relay; you never see a bill, a meter,
        or an upgrade prompt. Once you&apos;ve signed up to a service
        through your agent, asking the agent to refresh a key, rotate
        after a leak scare, or pull credentials again costs you nothing
        and never affects your access.
      </Row>
    </main>
  );
}
