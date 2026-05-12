import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const alt = 'Relay — agent-driven signup for any app';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  const fontDir = join(process.cwd(), 'public', 'fonts', 'PlusJakartaSans');
  const [light, semibold, bold] = await Promise.all([
    readFile(join(fontDir, 'PlusJakartaSans-Light.ttf')),
    readFile(join(fontDir, 'PlusJakartaSans-SemiBold.ttf')),
    readFile(join(fontDir, 'PlusJakartaSans-Bold.ttf')),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#f5f0e6',
          color: '#1a1a1a',
          padding: 64,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          fontFamily: 'Jakarta',
          position: 'relative',
        }}
      >
        {/* Hairline grid corners */}
        <div
          style={{
            position: 'absolute',
            top: 36,
            right: 36,
            width: 56,
            height: 56,
            borderTop: '1px solid #1a1a1a',
            borderRight: '1px solid #1a1a1a',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: 36,
            left: 36,
            width: 56,
            height: 56,
            borderBottom: '1px solid #1a1a1a',
            borderLeft: '1px solid #1a1a1a',
          }}
        />

        {/* Top kicker */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 18,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            fontWeight: 600,
            color: '#1a1a1a',
          }}
        >
          <span>Relay · 0.1.0</span>
          <span style={{ color: '#5a5a5a' }}>Agent-driven signup</span>
        </div>

        {/* Hero hook */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            maxWidth: 1000,
          }}
        >
          <div
            style={{
              fontSize: 110,
              lineHeight: 0.95,
              letterSpacing: '-0.035em',
              fontWeight: 300,
              color: '#1a1a1a',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>Your users sign up</span>
            <span>through their AI.</span>
          </div>
          <div
            style={{
              fontSize: 28,
              lineHeight: 1.4,
              color: '#3a3a3a',
              fontWeight: 400,
              maxWidth: 920,
            }}
          >
            Drop a webhook into your existing auth. Relay delivers
            activated, API-key-holding users to your service. You pay
            only per delivered signup.
          </div>
        </div>

        {/* Bottom row — wordmark + url + plan strip */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            paddingTop: 32,
            borderTop: '1px solid #1a1a1a',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontSize: 56,
                fontWeight: 700,
                letterSpacing: '-0.03em',
                color: '#1a1a1a',
              }}
            >
              Relay
            </span>
            <span
              style={{
                fontSize: 14,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: '#5a5a5a',
                fontWeight: 600,
              }}
            >
              by Cumulus
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 6,
            }}
          >
            <span
              style={{
                fontSize: 18,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: '#1a1a1a',
                fontWeight: 600,
              }}
            >
              relay.cumulush.com
            </span>
            <span
              style={{
                fontSize: 14,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: '#5a5a5a',
                fontWeight: 500,
              }}
            >
              Builder $49 / 1k actions · MIT SDK on npm
            </span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Jakarta', data: light, weight: 300, style: 'normal' },
        { name: 'Jakarta', data: semibold, weight: 600, style: 'normal' },
        { name: 'Jakarta', data: bold, weight: 700, style: 'normal' },
      ],
    },
  );
}
