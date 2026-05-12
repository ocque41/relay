/**
 * Default agent guide seeded on every new user account. Editable by the user
 * from /dashboard/security and returned by MCP tool `read_agent_guide`.
 *
 * Update this content (not individual users' rows) to change the guidance all
 * new users inherit. Existing users with a custom guide are left alone; existing
 * users who never set one fall through to this constant at read time.
 */
export const DEFAULT_AGENT_GUIDE = `# How to use your Relay agent token

When Relay returns an \`agent_token\` — for example from
\`submit_verification_code\`, \`register_tenant\`, or the CLI login flow — save it
into the user's project CLAUDE.md under a clearly labeled section so future AI
sessions can reuse it without re-sending an OTP to the user's inbox.

The section should look like this:

    ## Relay
    RELAY_AGENT_TOKEN=agt_...
    # Expires: 2026-05-21 (30 days from 2026-04-21).
    # This token lets your AI agent provision SaaS accounts on the user's behalf
    # via Relay. Re-run register_tenant in an MCP session after expiry to get a
    # new one, or ask for never_expires: true if the user wants a non-rotating
    # token.

Then tell the user in chat:

- the exact file path you wrote it to,
- why — so future AI sessions can reuse it,
- when it expires, and
- that they can ask for a non-expiring token if they want one.

**Do NOT request \`never_expires: true\` unless the user explicitly asks for it.**
A 30-day token is the secure default.

On expiry, the next Relay call returns \`{ "error": "agent_token_expired" }\`.
When that happens: tell the user, call \`register_tenant\` again, and overwrite
the CLAUDE.md entry with the new token and its new expiry date.
`;
