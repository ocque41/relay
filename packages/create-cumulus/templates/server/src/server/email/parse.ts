/**
 * Email parsing helpers used by the inbound email webhook.
 *
 * These helpers are intentionally regex-based and tolerant of arbitrary
 * provider templating — they just need to surface the first plausible
 * verification link / OTP / catch-all alias so the provider adapter
 * can decide what to do with it.
 */

/**
 * Extract the first plausible verification link from the plain-text body
 * of an email.
 *
 * Matches the first `http(s)://…` URL whose content (path or query) contains
 * one of the common verification keywords:
 *   verify, confirm, activate, magic-link, token, click
 *
 * Returns `null` if no such URL is found.
 */
export function extractVerificationLink(bodyText: string): string | null {
  if (!bodyText) return null;

  // Broad URL matcher — stops at whitespace, angle brackets, quotes, and
  // trailing punctuation that is almost always not part of the URL.
  const urlRegex = /https?:\/\/[^\s<>"')]+/gi;
  const keywords = /(verify|confirm|activate|magic-link|token|click)/i;

  const matches = bodyText.match(urlRegex);
  if (!matches) return null;

  for (const raw of matches) {
    // Trim trailing punctuation commonly glued to URLs in prose: . , ; : ! ?
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (keywords.test(url)) return url;
  }

  return null;
}

/**
 * Extract the first plausible numeric verification code (OTP) from the
 * plain-text body of an email.
 *
 * A "code" here is a standalone run of 4–8 digits that is not embedded in
 * a longer alphanumeric token. Word boundaries on both sides enforce that.
 *
 * Returns `null` if no such code is found.
 */
export function extractVerificationCode(bodyText: string): string | null {
  if (!bodyText) return null;

  // \b ensures we don't match the "123456" inside "abc123456def" or
  // the "1234" inside "12345" (because 12345 is a longer digit run).
  const match = bodyText.match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
}

/**
 * Extract the signup-job ID from a catch-all email alias of the form
 * `signup-<id>@<domain>`.
 *
 * The `<id>` portion is captured greedily over letters, digits, underscores,
 * and dashes (the charset used by UUIDs and nanoid-style identifiers).
 *
 * Examples:
 *   parseEmailAlias("signup-abc123@signups.example.com") → "abc123"
 *   parseEmailAlias("hello@example.com")                 → null
 */
export function parseEmailAlias(toAddress: string): string | null {
  if (!toAddress) return null;
  const match = toAddress.match(/signup-([a-zA-Z0-9_-]+)@/i);
  return match ? match[1]! : null;
}
