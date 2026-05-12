/**
 * Minimal Resend wrapper for Relay's own transactional email (OTPs etc.).
 * Independent from src/server/providers/resend.ts, which is about provisioning
 * Resend *accounts* for integrators.
 */
const RESEND_API_BASE = 'https://api.resend.com';

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

function getFromAddress(): string {
  return process.env.RELAY_FROM_ADDRESS ?? process.env.RESEND_FROM_ADDRESS ?? 'onboarding@resend.dev';
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'relay/1.0',
    },
    body: JSON.stringify({
      from: getFromAddress(),
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
  return (await res.json()) as { id: string };
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: `Your Relay verification code: ${code}`,
    text: `Your Relay verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html:
      `<p>Your Relay verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
      `<p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}
