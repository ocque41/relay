'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

// ── Brand tokens ────────────────────────────────────────────────────────────
const PAPER = '#f5f5f5';
const INK = '#1a1a1a';
const INK2 = 'rgba(26,26,26,0.64)';
const INK3 = 'rgba(26,26,26,0.42)';
const INK4 = 'rgba(26,26,26,0.32)';
const HAIR = 'rgba(26,26,26,0.14)';
const WASH = 'rgba(26,26,26,0.04)';
const MONO = 'var(--font-mono)';
const DISPLAY = 'var(--font-display)';

const STAGE_W = 1920;
const STAGE_H = 1080;
const DURATION = 60;
const PERSIST_KEY = 'relay-video:t';

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

// ── Timeline + Sprite contexts ──────────────────────────────────────────────
type TimelineCtx = {
  time: number;
  duration: number;
  playing: boolean;
};
const TimelineContext = createContext<TimelineCtx>({
  time: 0,
  duration: DURATION,
  playing: false,
});
const useTimeline = () => useContext(TimelineContext);

type SpriteCtx = {
  localTime: number;
  progress: number;
  duration: number;
  visible: boolean;
};
const SpriteContext = createContext<SpriteCtx>({
  localTime: 0,
  progress: 0,
  duration: 0,
  visible: false,
});

type SpriteRenderProp = (ctx: SpriteCtx) => ReactNode;
function Sprite({
  start = 0,
  end = Infinity,
  children,
  keepMounted = false,
}: {
  start?: number;
  end?: number;
  children: ReactNode | SpriteRenderProp;
  keepMounted?: boolean;
}) {
  const { time } = useTimeline();
  const visible = time >= start && time <= end;
  if (!visible && !keepMounted) return null;

  const duration = end - start;
  const localTime = Math.max(0, time - start);
  const progress =
    duration > 0 && Number.isFinite(duration)
      ? clamp(localTime / duration, 0, 1)
      : 0;

  const value: SpriteCtx = { localTime, progress, duration, visible };

  return (
    <SpriteContext.Provider value={value}>
      {typeof children === 'function'
        ? (children as SpriteRenderProp)(value)
        : children}
    </SpriteContext.Provider>
  );
}

// ── Shared primitives ───────────────────────────────────────────────────────
function BrandMark({
  x = 0,
  y = 0,
  opacity = 1,
}: {
  x?: number;
  y?: number;
  opacity?: number;
}) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity }}>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '0.22em',
          fontWeight: 600,
          color: INK,
          textTransform: 'uppercase',
        }}
      >
        RELAY
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: '0.16em',
          fontWeight: 400,
          color: INK3,
          textTransform: 'uppercase',
          marginTop: 4,
        }}
      >
        by Cumulus
      </div>
    </div>
  );
}

function Kicker({
  x,
  y,
  children,
  opacity = 1,
  color = INK3,
}: {
  x: number;
  y: number;
  children: ReactNode;
  opacity?: number;
  color?: string;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: '0.20em',
        textTransform: 'uppercase',
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}

function Hair({
  x,
  y,
  width,
  opacity = 1,
  color = HAIR,
  thickness = 1,
}: {
  x: number;
  y: number;
  width: number;
  opacity?: number;
  color?: string;
  thickness?: number;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height: thickness,
        background: color,
        opacity,
      }}
    />
  );
}

function Typewriter({
  x,
  y,
  text,
  charsPerSec = 28,
  size = 14,
  color = INK,
  weight = 400,
  prefix = null,
  cursor = true,
  spriteLocal,
}: {
  x: number;
  y: number;
  text: string;
  charsPerSec?: number;
  size?: number;
  color?: string;
  weight?: number;
  prefix?: ReactNode;
  cursor?: boolean;
  spriteLocal: number;
}) {
  const n = Math.min(text.length, Math.floor(spriteLocal * charsPerSec));
  const shown = text.slice(0, n);
  const done = n >= text.length;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        fontFamily: MONO,
        fontSize: size,
        color,
        fontWeight: weight,
        letterSpacing: '0.01em',
        whiteSpace: 'pre',
      }}
    >
      {prefix}
      <span>{shown}</span>
      {cursor && !done && (
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: size * 0.9,
            background: color,
            marginLeft: 2,
            verticalAlign: 'middle',
            opacity: Math.floor(spriteLocal * 2) % 2 ? 0 : 1,
          }}
        />
      )}
    </div>
  );
}

// ── Scene 1: Intro (0..6s) ──────────────────────────────────────────────────
function SceneIntro({ start = 0, duration = 6 }: { start?: number; duration?: number }) {
  return (
    <Sprite start={start} end={start + duration}>
      {({ localTime }) => {
        const t = localTime;
        const brandOpacity = Math.min(1, t / 0.5);
        const kickerOpacity = Math.max(0, Math.min(1, (t - 0.3) / 0.6));
        const urlReveal = Math.max(0, Math.min(1, (t - 0.8) / 1.6));
        const underline = Math.max(0, Math.min(1, (t - 2.0) / 0.8));
        const line1 = Math.max(0, Math.min(1, (t - 2.8) / 0.5));
        const line2 = Math.max(0, Math.min(1, (t - 3.2) / 0.5));
        const line3 = Math.max(0, Math.min(1, (t - 3.6) / 0.5));
        const fadeOut = Math.max(0, Math.min(1, (t - 5.4) / 0.6));
        const op = 1 - fadeOut;

        const url = 'relay.cumulush.com';
        const charCount = Math.floor(urlReveal * url.length);
        const urlShown = url.slice(0, charCount);

        return (
          <div style={{ position: 'absolute', inset: 0, opacity: op }}>
            <BrandMark x={80} y={64} opacity={brandOpacity} />
            <Kicker x={80} y={120} opacity={kickerOpacity}>
              00 — The on-ramp
            </Kicker>

            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 220,
                fontFamily: DISPLAY,
                fontSize: 128,
                fontWeight: 300,
                letterSpacing: '-0.045em',
                lineHeight: 0.9,
                color: INK,
                whiteSpace: 'nowrap',
              }}
            >
              {urlShown}
              {urlReveal < 1 && urlReveal > 0 && (
                <span
                  style={{
                    display: 'inline-block',
                    width: 4,
                    height: 110,
                    background: INK,
                    marginLeft: 6,
                    verticalAlign: 'middle',
                    opacity: Math.floor(t * 3) % 2 ? 0 : 1,
                  }}
                />
              )}
            </div>

            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 370,
                width: 1320,
                height: 3,
                background: INK,
                transform: `scaleX(${underline})`,
                transformOrigin: 'left',
              }}
            />

            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 430,
                fontFamily: DISPLAY,
                fontSize: 44,
                fontWeight: 300,
                letterSpacing: '-0.025em',
                lineHeight: 1.2,
                color: INK,
              }}
            >
              <div style={{ opacity: line1 }}>People&apos;s AI agents</div>
              <div style={{ opacity: line2 }}>sign up &amp; commit actions —</div>
              <div style={{ opacity: line3, color: INK2 }}>for them.</div>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 80,
                bottom: 56,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
                opacity: line3,
              }}
            >
              01 / 04 · Intro
            </div>
            <div
              style={{
                position: 'absolute',
                right: 80,
                bottom: 56,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
                opacity: line3,
              }}
            >
              Cumulus · 2026
            </div>
          </div>
        );
      }}
    </Sprite>
  );
}

// ── Scene 2: Provider (6..22s) ──────────────────────────────────────────────
function SceneProvider({ start = 6, duration = 16 }: { start?: number; duration?: number }) {
  return (
    <Sprite start={start} end={start + duration}>
      {({ localTime }) => {
        const t = localTime;
        const fadeIn = Math.min(1, t / 0.5);
        const fadeOut = Math.max(0, Math.min(1, (t - (duration - 0.6)) / 0.6));
        const op = fadeIn * (1 - fadeOut);

        const chat1 = Math.max(0, Math.min(1, (t - 0.4) / 0.4));
        const chat2 = Math.max(0, Math.min(1, (t - 1.6) / 0.4));

        const termShow = Math.max(0, Math.min(1, (t - 2.0) / 0.4));
        const cmdLocal = Math.max(0, t - 2.5);
        const respShow = Math.max(0, Math.min(1, (t - 5.0) / 0.5));

        const dashShow = Math.max(0, Math.min(1, (t - 7.5) / 0.7));
        const dashBar = Math.max(0, Math.min(1, (t - 9.0) / 1.2));
        const dashChip = Math.max(0, Math.min(1, (t - 10.5) / 0.5));

        return (
          <div style={{ position: 'absolute', inset: 0, opacity: op }}>
            <BrandMark x={80} y={64} />
            <Kicker x={80} y={120}>01 — Register your product</Kicker>
            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 150,
                width: 900,
                fontFamily: DISPLAY,
                fontSize: 52,
                fontWeight: 300,
                letterSpacing: '-0.035em',
                lineHeight: 1.0,
                color: INK,
              }}
            >
              One command.
              <br />
              Your product becomes
              <br />
              <span style={{ color: INK2 }}>agent-accessible.</span>
            </div>

            <div style={{ position: 'absolute', left: 80, top: 420, width: 720, opacity: chat1 }}>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: '0.20em',
                  textTransform: 'uppercase',
                  color: INK3,
                  marginBottom: 14,
                }}
              >
                You → Claude
              </div>
              <div
                style={{
                  fontFamily: DISPLAY,
                  fontSize: 24,
                  fontWeight: 400,
                  letterSpacing: '-0.01em',
                  lineHeight: 1.4,
                  color: INK,
                }}
              >
                &quot;I want my users to sign up for my product
                <br />
                through their AI agent.&quot;
              </div>
            </div>

            <div style={{ position: 'absolute', left: 80, top: 560, width: 720, opacity: chat2 }}>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: '0.20em',
                  textTransform: 'uppercase',
                  color: INK3,
                  marginBottom: 14,
                }}
              >
                Claude
              </div>
              <div
                style={{
                  fontFamily: DISPLAY,
                  fontSize: 20,
                  fontWeight: 400,
                  letterSpacing: '-0.005em',
                  lineHeight: 1.45,
                  color: INK2,
                }}
              >
                Registering with Relay. I&apos;ll paste the
                <br />
                webhook secret into your .env.
              </div>
            </div>

            {termShow > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: 920,
                  top: 420,
                  width: 920,
                  height: 440,
                  background: PAPER,
                  border: `1px solid ${INK}`,
                  borderRadius: 5.5,
                  boxShadow: '0 18px 40px rgba(26,26,26,0.18)',
                  overflow: 'hidden',
                  opacity: termShow,
                  transform: `translateY(${(1 - termShow) * 24}px)`,
                }}
              >
                <div
                  style={{
                    height: 34,
                    borderBottom: `1px solid ${HAIR}`,
                    display: 'flex',
                    alignItems: 'center',
                    paddingLeft: 16,
                    paddingRight: 16,
                    gap: 12,
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: '0.20em',
                    textTransform: 'uppercase',
                    color: INK3,
                    justifyContent: 'space-between',
                  }}
                >
                  <span>claude-code · zsh</span>
                  <span style={{ color: INK4 }}>~/my-product</span>
                </div>
                <div style={{ padding: 20, position: 'relative', height: 406 }}>
                  <Typewriter
                    x={0}
                    y={0}
                    prefix={<span style={{ color: INK3 }}>$ </span>}
                    text={'npx create-cumulus@latest acme'}
                    size={15}
                    charsPerSec={34}
                    spriteLocal={cmdLocal}
                  />
                  {t > 3.7 && (
                    <Typewriter
                      x={0}
                      y={30}
                      prefix={<span style={{ color: INK3 }}>$ </span>}
                      text={'  --name "my-product" --webhook /api/relay'}
                      size={15}
                      charsPerSec={44}
                      spriteLocal={Math.max(0, t - 3.7)}
                    />
                  )}

                  {t > 4.6 && t < 5.1 && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 72,
                        fontFamily: MONO,
                        fontSize: 13,
                        color: INK3,
                      }}
                    >
                      ⠋ provisioning…
                    </div>
                  )}

                  {respShow > 0 && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 20,
                        top: 92,
                        opacity: respShow,
                        fontFamily: MONO,
                        fontSize: 13,
                        lineHeight: 1.7,
                        color: INK,
                      }}
                    >
                      <div style={{ color: INK3 }}>✓ product registered</div>
                      <div style={{ marginTop: 14 }}>
                        <span style={{ color: INK3 }}>product_id</span>{'  '}
                        <span>prod_8fq2kxn4dh</span>
                      </div>
                      <div>
                        <span style={{ color: INK3 }}>secret</span>{'       '}
                        <span>rly_sk_•••••••••••••••••••••</span>
                      </div>
                      <div>
                        <span style={{ color: INK3 }}>webhook</span>{'      '}
                        <span>https://my-product.app/api/relay</span>
                      </div>
                      <div>
                        <span style={{ color: INK3 }}>mcp_endpoint</span>{' '}
                        <span>relay.cumulush.com/mcp</span>
                      </div>
                      <div>
                        <span style={{ color: INK3 }}>status</span>{'       '}
                        <span style={{ fontWeight: 600 }}>live</span>
                      </div>
                      <div style={{ marginTop: 18, color: INK2 }}>
                        ↳ 30 trial signups included. Founders tier.
                      </div>
                      {t > 6.2 && (
                        <div style={{ marginTop: 16, color: INK, fontWeight: 600 }}>
                          ${' '}
                          <span
                            style={{
                              display: 'inline-block',
                              width: 7,
                              height: 14,
                              background: INK,
                              marginLeft: 2,
                              verticalAlign: '-2px',
                              opacity: Math.floor(t * 2.5) % 2 ? 0 : 1,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {dashShow > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: 80,
                  top: 900,
                  width: 1760,
                  opacity: dashShow,
                  transform: `translateY(${(1 - dashShow) * 16}px)`,
                }}
              >
                <Hair x={0} y={-20} width={1760} />
                <div style={{ display: 'flex', gap: 64, paddingTop: 32 }}>
                  <div style={{ flex: '0 0 420px' }}>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: '0.20em',
                        textTransform: 'uppercase',
                        color: INK3,
                      }}
                    >
                      Product
                    </div>
                    <div
                      style={{
                        marginTop: 14,
                        fontFamily: DISPLAY,
                        fontSize: 36,
                        fontWeight: 400,
                        letterSpacing: '-0.02em',
                        color: INK,
                      }}
                    >
                      my-product
                    </div>
                  </div>
                  <div style={{ flex: '0 0 280px' }}>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: '0.20em',
                        textTransform: 'uppercase',
                        color: INK3,
                      }}
                    >
                      Webhook
                    </div>
                    <div
                      style={{
                        marginTop: 14,
                        fontFamily: MONO,
                        fontSize: 22,
                        fontWeight: 400,
                        letterSpacing: '-0.01em',
                        color: INK,
                      }}
                    >
                      /api/relay
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          background: INK,
                          transform: `scale(${dashBar})`,
                        }}
                      />
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          letterSpacing: '0.18em',
                          textTransform: 'uppercase',
                          color: INK,
                          opacity: dashBar,
                        }}
                      >
                        Live
                      </div>
                    </div>
                  </div>
                  <div style={{ flex: '0 0 320px' }}>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: '0.20em',
                        textTransform: 'uppercase',
                        color: INK3,
                      }}
                    >
                      Included signups
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: DISPLAY,
                        fontSize: 72,
                        fontWeight: 300,
                        letterSpacing: '-0.04em',
                        lineHeight: 0.9,
                        color: INK,
                      }}
                    >
                      30
                    </div>
                  </div>
                  <div style={{ flex: 1, opacity: dashChip }}>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: '0.20em',
                        textTransform: 'uppercase',
                        color: INK3,
                      }}
                    >
                      Now discoverable at
                    </div>
                    <div
                      style={{
                        marginTop: 14,
                        fontFamily: DISPLAY,
                        fontSize: 28,
                        fontWeight: 400,
                        letterSpacing: '-0.02em',
                        color: INK,
                      }}
                    >
                      relay.cumulush.com/mcp
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        fontFamily: MONO,
                        fontSize: 12,
                        color: INK3,
                        letterSpacing: '0.02em',
                      }}
                    >
                      Any agent on any MCP client can now sign their user up.
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div
              style={{
                position: 'absolute',
                left: 80,
                bottom: 36,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              02 / 04 · For providers
            </div>
            <div
              style={{
                position: 'absolute',
                right: 80,
                bottom: 36,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              relay.cumulush.com
            </div>
          </div>
        );
      }}
    </Sprite>
  );
}

// ── Scene 3: End-user (22..52s) ─────────────────────────────────────────────
type Provider = { name: string; desc: string; pricing: string; meta: string };

function ChatBlock({
  y,
  opacity,
  user,
  agent,
  agentAction,
  spriteLocal,
  actionStart = 2.2,
}: {
  y: number;
  opacity: number;
  user: string;
  agent: string;
  agentAction: string;
  spriteLocal: number;
  actionStart?: number;
}) {
  const uTyped = Math.min(1, Math.max(0, spriteLocal / 0.8));
  const aTyped = Math.min(1, Math.max(0, (spriteLocal - 1.0) / 1.0));
  const actionOp = Math.min(1, Math.max(0, (spriteLocal - actionStart) / 0.5));
  return (
    <div style={{ position: 'absolute', left: 80, top: y, width: 820, opacity }}>
      <div style={{ opacity: uTyped }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '0.20em',
            textTransform: 'uppercase',
            color: INK3,
            marginBottom: 10,
          }}
        >
          User
        </div>
        <div
          style={{
            fontFamily: DISPLAY,
            fontSize: 28,
            fontWeight: 400,
            letterSpacing: '-0.015em',
            lineHeight: 1.35,
            color: INK,
          }}
        >
          &quot;{user}&quot;
        </div>
      </div>
      <div style={{ opacity: aTyped, marginTop: 36 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '0.20em',
            textTransform: 'uppercase',
            color: INK3,
            marginBottom: 10,
          }}
        >
          Claude
        </div>
        <div
          style={{
            fontFamily: DISPLAY,
            fontSize: 22,
            fontWeight: 400,
            letterSpacing: '-0.005em',
            lineHeight: 1.45,
            color: INK2,
          }}
        >
          {agent}
        </div>
      </div>
      <div
        style={{
          opacity: actionOp,
          marginTop: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div style={{ width: 20, height: 1, background: INK }} />
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: INK,
            fontWeight: 600,
          }}
        >
          {agentAction}
        </div>
      </div>
    </div>
  );
}

function IndexCard({
  y,
  opacity,
  category,
  providers,
  pickedIdx,
  spriteLocal,
  queryStart = 0.4,
}: {
  y: number;
  opacity: number;
  category: string;
  providers: Provider[];
  pickedIdx: number;
  spriteLocal: number;
  queryStart?: number;
}) {
  const queryOp = Math.min(1, Math.max(0, (spriteLocal - queryStart) / 0.5));
  return (
    <div style={{ position: 'absolute', left: 1020, top: y, width: 820, opacity }}>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: '0.20em',
          textTransform: 'uppercase',
          color: INK3,
        }}
      >
        GET /v1/providers
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 15,
          color: INK,
          opacity: queryOp,
        }}
      >
        ?category={'"'}
        <span style={{ fontWeight: 600 }}>{category}</span>
        {'"'}
      </div>

      <div style={{ marginTop: 36, borderTop: `1px solid ${INK}`, paddingTop: 20 }}>
        {providers.map((p, i) => {
          const itemOp = Math.min(1, Math.max(0, (spriteLocal - (1.2 + i * 0.35)) / 0.4));
          const isPicked = i === pickedIdx;
          const pickOp = Math.min(1, Math.max(0, (spriteLocal - 3.5) / 0.5));
          return (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr 140px 100px',
                gap: 24,
                alignItems: 'center',
                padding: '14px 0',
                borderBottom: `1px solid ${HAIR}`,
                opacity: itemOp,
                background: isPicked ? `rgba(26,26,26,${0.04 * pickOp})` : 'transparent',
                paddingLeft: isPicked ? 8 : 0,
                transition: 'padding 200ms',
              }}
            >
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  color: INK4,
                }}
              >
                {String(i + 1).padStart(2, '0')}
              </div>
              <div>
                <div
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 20,
                    fontWeight: 500,
                    letterSpacing: '-0.01em',
                    color: INK,
                  }}
                >
                  {p.name}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: MONO,
                    fontSize: 11,
                    color: INK3,
                    letterSpacing: '0.02em',
                  }}
                >
                  {p.desc}
                </div>
              </div>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  color: INK2,
                  letterSpacing: '0.02em',
                }}
              >
                {p.pricing}
              </div>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: isPicked ? INK : INK3,
                  fontWeight: isPicked ? 600 : 400,
                  textAlign: 'right',
                  opacity: isPicked ? pickOp : 1,
                }}
              >
                {isPicked ? '↳ picked' : p.meta}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 24,
          fontFamily: MONO,
          fontSize: 11,
          color: INK3,
          letterSpacing: '0.02em',
          opacity: Math.min(1, Math.max(0, (spriteLocal - 4.0) / 0.6)),
        }}
      >
        ↳ chunked · paginated · agent reads only what it needs
      </div>
    </div>
  );
}

type ResultKind = 'app' | 'db' | 'ai';

function ResultCard({
  y,
  opacity,
  kind,
  spriteLocal,
  revealStart = 6.0,
}: {
  y: number;
  opacity: number;
  kind: ResultKind;
  spriteLocal: number;
  revealStart?: number;
}) {
  const revealOp = Math.min(1, Math.max(0, (spriteLocal - revealStart) / 0.6));
  const bar = Math.min(1, Math.max(0, (spriteLocal - (revealStart + 0.2)) / 1.2));

  return (
    <div
      style={{
        position: 'absolute',
        left: 80,
        top: y,
        width: 1760,
        opacity: opacity * revealOp,
        transform: `translateY(${(1 - revealOp) * 16}px)`,
      }}
    >
      <Hair x={0} y={-28} width={1760} color={INK} thickness={1} />
      {kind === 'app' && (
        <div style={{ display: 'flex', gap: 64, paddingTop: 32, alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 400px' }}>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              Downloaded · 0 clicks from user
            </div>
            <div
              style={{
                marginTop: 12,
                fontFamily: DISPLAY,
                fontSize: 40,
                fontWeight: 400,
                letterSpacing: '-0.02em',
                color: INK,
              }}
            >
              Acme.app
            </div>
          </div>
          <div style={{ flex: '0 0 480px' }}>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              Signed installer
            </div>
            <div
              style={{
                marginTop: 14,
                fontFamily: MONO,
                fontSize: 15,
                color: INK,
              }}
            >
              ~/Downloads/Acme-1.4.2.dmg
            </div>
            <div
              style={{
                marginTop: 14,
                width: '100%',
                height: 2,
                background: 'rgba(26,26,26,0.12)',
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  height: '100%',
                  width: `${bar * 100}%`,
                  background: INK,
                }}
              />
            </div>
            <div
              style={{
                marginTop: 10,
                fontFamily: MONO,
                fontSize: 11,
                color: INK3,
                letterSpacing: '0.02em',
              }}
            >
              {Math.round(bar * 184)} MB / 184 MB
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              Handed to user
            </div>
            <div
              style={{
                marginTop: 14,
                fontFamily: DISPLAY,
                fontSize: 22,
                fontWeight: 400,
                color: INK2,
                lineHeight: 1.4,
                letterSpacing: '-0.005em',
              }}
            >
              &quot;Installed. Sign-in is already in the app — you&apos;re in.&quot;
            </div>
          </div>
        </div>
      )}
      {kind === 'db' && (
        <div style={{ paddingTop: 32 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: '0.20em',
              textTransform: 'uppercase',
              color: INK3,
            }}
          >
            Written to .env · AES-256-GCM at rest
          </div>
          <div
            style={{
              marginTop: 22,
              padding: 24,
              background: WASH,
              border: `1px solid ${HAIR}`,
              borderRadius: 5.5,
              fontFamily: MONO,
              fontSize: 17,
              lineHeight: 1.8,
              color: INK,
            }}
          >
            <div>
              <span style={{ color: INK3 }}>DATABASE_URL=</span>
              postgres://neondb_owner:•••••••••@ep-wispy-base-ae3h
              {bar > 0.3 ? '42' : ''}
              {bar > 0.5 ? 'qf' : ''}
              {bar > 0.7 ? '.c-2.us-east-2.aws.neon.tech' : ''}
              {bar > 0.95 ? '/neondb' : ''}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: INK3 }}>DATABASE_DIRECT_URL=</span>
              postgres://neondb_owner:•••••••••@ep-wispy-base-ae3h
              {bar > 0.95 ? '42qf.us-east-2.aws.neon.tech/neondb' : ''}
            </div>
          </div>
          <div
            style={{
              marginTop: 18,
              fontFamily: DISPLAY,
              fontSize: 22,
              fontWeight: 400,
              color: INK2,
              letterSpacing: '-0.005em',
            }}
          >
            &quot;Done. Run npm run dev — the branch is provisioned.&quot;
          </div>
        </div>
      )}
      {kind === 'ai' && (
        <div style={{ paddingTop: 32 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: '0.20em',
              textTransform: 'uppercase',
              color: INK3,
            }}
          >
            Written to .env · Revealed once, then encrypted
          </div>
          <div
            style={{
              marginTop: 22,
              padding: 24,
              background: WASH,
              border: `1px solid ${HAIR}`,
              borderRadius: 5.5,
              fontFamily: MONO,
              fontSize: 17,
              lineHeight: 1.8,
              color: INK,
            }}
          >
            <div>
              <span style={{ color: INK3 }}>ANTHROPIC_API_KEY=</span>
              demo-anthropic-key-
              {bar > 0.2 ? 'xF9' : ''}
              {bar > 0.35 ? 'kL2vQ8w' : ''}
              {bar > 0.55 ? 'rN4mY7b' : ''}
              {bar > 0.75 ? 'pC1aZ6d' : ''}
              {bar > 0.95 ? '-aXQqAA' : ''}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: INK3 }}>ANTHROPIC_MODEL=</span>
              {bar > 0.95 ? 'claude-sonnet-4-6' : ''}
            </div>
          </div>
          <div
            style={{
              marginTop: 18,
              fontFamily: DISPLAY,
              fontSize: 22,
              fontWeight: 400,
              color: INK2,
              letterSpacing: '-0.005em',
            }}
          >
            &quot;Key provisioned with $5 trial credit. Ready to use.&quot;
          </div>
        </div>
      )}
    </div>
  );
}

function Mini({
  start,
  duration,
  idx,
  title,
  user,
  agent,
  agentAction,
  category,
  providers,
  pickedIdx,
  resultKind,
}: {
  start: number;
  duration: number;
  idx: number;
  title: string;
  user: string;
  agent: string;
  agentAction: string;
  category: string;
  providers: Provider[];
  pickedIdx: number;
  resultKind: ResultKind;
}) {
  return (
    <Sprite start={start} end={start + duration}>
      {({ localTime }) => {
        const t = localTime;
        const fadeIn = Math.min(1, t / 0.4);
        const fadeOut = Math.max(0, Math.min(1, (t - (duration - 0.5)) / 0.5));
        const op = fadeIn * (1 - fadeOut);

        return (
          <div style={{ position: 'absolute', inset: 0, opacity: op }}>
            <BrandMark x={80} y={64} />
            <Kicker x={80} y={120}>{`0${idx} — ${title}`}</Kicker>
            <Kicker x={1700} y={120} color={INK}>{`0${idx} / 03`}</Kicker>

            <ChatBlock
              y={220}
              opacity={1}
              user={user}
              agent={agent}
              agentAction={agentAction}
              spriteLocal={t}
            />

            <IndexCard
              y={220}
              opacity={1}
              category={category}
              providers={providers}
              pickedIdx={pickedIdx}
              spriteLocal={t}
            />

            <ResultCard y={810} opacity={1} kind={resultKind} spriteLocal={t} />

            <div
              style={{
                position: 'absolute',
                left: 80,
                bottom: 36,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              03 / 04 · For end-users
            </div>
            <div
              style={{
                position: 'absolute',
                right: 80,
                bottom: 36,
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.20em',
                textTransform: 'uppercase',
                color: INK3,
              }}
            >
              relay.cumulush.com
            </div>
          </div>
        );
      }}
    </Sprite>
  );
}

function SceneEndUser({ start = 22 }: { start?: number }) {
  return (
    <>
      <Mini
        start={start + 0}
        duration={10}
        idx={1}
        title="Need a desktop app"
        user="I need a macOS app for AI-agent terminals."
        agent="Looking it up. Acme matches — signing you up and grabbing the installer now."
        agentAction="create_signup(provider: acme) · download()"
        category="desktop-app"
        pickedIdx={0}
        providers={[
          { name: 'Acme', desc: 'Agent-ready desktop workspace for macOS', pricing: 'Free · $19/mo pro', meta: 'macOS 14+' },
          { name: 'Warp', desc: 'Rust terminal with AI block', pricing: 'Free · team plans', meta: 'macOS · Linux' },
          { name: 'Zed', desc: 'Multiplayer code editor', pricing: 'Free · pro $20/mo', meta: 'macOS · Linux' },
        ]}
        resultKind="app"
      />
      <Mini
        start={start + 10}
        duration={10}
        idx={2}
        title="Need a cloud database"
        user="Spin up a Postgres database for this project."
        agent="Checking providers. Neon fits — serverless, branching, free tier. Provisioning a branch."
        agentAction="create_signup(provider: neon) · write_env(DATABASE_URL)"
        category="cloud-database"
        pickedIdx={0}
        providers={[
          { name: 'Neon', desc: 'Serverless Postgres with branching', pricing: 'Free · $19/mo', meta: 'Postgres 16' },
          { name: 'Supabase', desc: 'Postgres + auth + storage', pricing: 'Free · $25/mo', meta: 'Postgres 15' },
          { name: 'Turso', desc: 'Edge SQLite, globally replicated', pricing: 'Free · $29/mo', meta: 'libSQL' },
        ]}
        resultKind="db"
      />
      <Mini
        start={start + 20}
        duration={10}
        idx={3}
        title="Need an AI provider"
        user="Add an LLM to this project — something good at code."
        agent="Anthropic's Sonnet 4.6 leads code benchmarks. Signing up, minting a key, writing .env."
        agentAction="create_signup(provider: anthropic) · reveal_api_key()"
        category="ai-provider"
        pickedIdx={0}
        providers={[
          { name: 'Anthropic', desc: 'Claude · Sonnet 4.6 · Haiku 4.5', pricing: '$3 / $15 per 1M tok', meta: '$5 trial' },
          { name: 'OpenAI', desc: 'GPT-5.4 · o-series reasoning', pricing: '$2.5 / $10 per 1M', meta: 'API tier 1' },
          { name: 'Google', desc: 'Gemini 2.5 Pro · Flash', pricing: '$1.25 / $10 per 1M', meta: 'AI Studio' },
        ]}
        resultKind="ai"
      />
    </>
  );
}

// ── Scene 4: Outro (52..60s) ────────────────────────────────────────────────
function SceneOutro({ start = 52, duration = 8 }: { start?: number; duration?: number }) {
  return (
    <Sprite start={start} end={start + duration}>
      {({ localTime }) => {
        const t = localTime;
        const kickerOp = Math.min(1, t / 0.4);
        const tag1 = Math.min(1, Math.max(0, (t - 0.3) / 0.6));
        const tag2 = Math.min(1, Math.max(0, (t - 0.8) / 0.6));
        const tag3 = Math.min(1, Math.max(0, (t - 1.3) / 0.6));

        const statsOp = Math.min(1, Math.max(0, (t - 2.0) / 0.5));
        const countRaw = Math.min(1, Math.max(0, (t - 2.0) / 1.4));
        const count = Math.floor(countRaw * 127);

        const urlOp = Math.min(1, Math.max(0, (t - 3.2) / 0.7));
        const urlUnderline = Math.min(1, Math.max(0, (t - 4.0) / 1.0));
        const ctaOp = Math.min(1, Math.max(0, (t - 5.2) / 0.6));

        const fadeOut = Math.max(0, Math.min(1, (t - (duration - 0.4)) / 0.4));
        const op = 1 - fadeOut;

        return (
          <div style={{ position: 'absolute', inset: 0, opacity: op }}>
            <BrandMark x={80} y={64} />
            <Kicker x={80} y={120} opacity={kickerOp}>04 — Ship</Kicker>

            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 220,
                width: 1400,
                fontFamily: DISPLAY,
                fontWeight: 300,
                letterSpacing: '-0.035em',
                lineHeight: 0.98,
              }}
            >
              <div style={{ opacity: tag1, fontSize: 80, color: INK }}>Your users sign up.</div>
              <div style={{ opacity: tag2, fontSize: 80, color: INK, marginTop: 6 }}>
                Through their AI.
              </div>
              <div
                style={{
                  opacity: tag3,
                  fontSize: 32,
                  color: INK2,
                  marginTop: 34,
                  fontWeight: 300,
                  letterSpacing: '-0.01em',
                }}
              >
                Drop a 20-line webhook. Get activated, API-key-holding users.
                <br />
                Pay only per delivered signup.
              </div>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 640,
                width: 1760,
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 48,
                opacity: statsOp,
                borderTop: `1px solid ${INK}`,
                paddingTop: 32,
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 96,
                    fontWeight: 300,
                    letterSpacing: '-0.04em',
                    lineHeight: 0.9,
                    color: INK,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {count}
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: '0.20em',
                    textTransform: 'uppercase',
                    color: INK3,
                  }}
                >
                  Providers in index
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 96,
                    fontWeight: 300,
                    letterSpacing: '-0.04em',
                    lineHeight: 0.9,
                    color: INK,
                  }}
                >
                  20
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: '0.20em',
                    textTransform: 'uppercase',
                    color: INK3,
                  }}
                >
                  Lines to integrate
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 96,
                    fontWeight: 300,
                    letterSpacing: '-0.04em',
                    lineHeight: 0.9,
                    color: INK,
                  }}
                >
                  60s
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: '0.20em',
                    textTransform: 'uppercase',
                    color: INK3,
                  }}
                >
                  Provider onboarding
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 96,
                    fontWeight: 300,
                    letterSpacing: '-0.04em',
                    lineHeight: 0.9,
                    color: INK,
                  }}
                >
                  $0
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: '0.20em',
                    textTransform: 'uppercase',
                    color: INK3,
                  }}
                >
                  To end-users
                </div>
              </div>
            </div>

            <div style={{ position: 'absolute', left: 80, top: 860, opacity: urlOp }}>
              <div
                style={{
                  fontFamily: DISPLAY,
                  fontSize: 160,
                  fontWeight: 300,
                  letterSpacing: '-0.05em',
                  lineHeight: 0.9,
                  color: INK,
                  whiteSpace: 'nowrap',
                }}
              >
                relay.cumulush.com
              </div>
              <div
                style={{
                  marginTop: 18,
                  width: 1760,
                  height: 3,
                  background: INK,
                  transform: `scaleX(${urlUnderline})`,
                  transformOrigin: 'left',
                }}
              />
            </div>

            <div
              style={{
                position: 'absolute',
                left: 80,
                bottom: 36,
                right: 80,
                display: 'flex',
                justifyContent: 'space-between',
                opacity: ctaOp,
                fontFamily: MONO,
                fontSize: 12,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: INK,
              }}
            >
              <div>npx create-cumulus@latest acme</div>
              <div>04 / 04 · Ship</div>
              <div>Cumulus · 2026</div>
            </div>
          </div>
        );
      }}
    </Sprite>
  );
}

// ── Scenes composition ──────────────────────────────────────────────────────
function Scenes() {
  return (
    <>
      <SceneIntro start={0} duration={6} />
      <SceneProvider start={6} duration={16} />
      <SceneEndUser start={22} />
      <SceneOutro start={52} duration={8} />
    </>
  );
}

// ── Canvas (the 1920×1080 scaled stage with timeline context) ───────────────
function Canvas({
  time,
  playing = false,
  containerRef,
}: {
  time: number;
  playing?: boolean;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = containerRef ?? localRef;
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const s = Math.min(el.clientWidth / STAGE_W, el.clientHeight / STAGE_H);
      setScale(Math.max(0.05, s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [wrapRef]);

  const ctx = useMemo<TimelineCtx>(
    () => ({ time, duration: DURATION, playing }),
    [time, playing],
  );

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: STAGE_W,
          height: STAGE_H,
          background: PAPER,
          position: 'relative',
          transform: `scale(${scale})`,
          transformOrigin: 'center',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <TimelineContext.Provider value={ctx}>
          <Scenes />
        </TimelineContext.Provider>
      </div>
    </div>
  );
}

// ── Animation loop hook (RAF + setInterval fallback) ────────────────────────
function usePlayhead(playing: boolean, initial: number, persist?: string) {
  const [time, setTime] = useState<number>(() => {
    if (typeof window === 'undefined' || !persist) return initial;
    try {
      const v = parseFloat(localStorage.getItem(persist) || '');
      return Number.isFinite(v) ? clamp(v, 0, DURATION) : initial;
    } catch {
      return initial;
    }
  });

  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!persist) return;
    try {
      localStorage.setItem(persist, String(time));
    } catch {
      /* ignore */
    }
  }, [time, persist]);

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }
    let stopped = false;
    let rafId: number | null = null;
    const tick = () => {
      const now = performance.now();
      if (lastTsRef.current == null) lastTsRef.current = now;
      const dt = Math.min(0.25, (now - lastTsRef.current) / 1000);
      lastTsRef.current = now;
      setTime((t) => {
        let next = t + dt;
        if (next >= DURATION) next = next % DURATION;
        return next;
      });
    };
    const rafStep = () => {
      if (stopped) return;
      tick();
      rafId = requestAnimationFrame(rafStep);
    };
    rafId = requestAnimationFrame(rafStep);
    const intervalId = window.setInterval(() => {
      if (document.hidden || !document.hasFocus()) tick();
    }, 50);
    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      lastTsRef.current = null;
    };
  }, [playing]);

  return [time, setTime] as const;
}

// ── Playback bar ────────────────────────────────────────────────────────────
function PlaybackBar({
  time,
  duration,
  playing,
  onPlayPause,
  onReset,
  onSeek,
  onHover,
  variant = 'dark',
}: {
  time: number;
  duration: number;
  playing: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  onSeek: (t: number) => void;
  onHover: (t: number | null) => void;
  variant?: 'dark' | 'light';
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const timeFromEvent = useCallback(
    (e: { clientX: number }) => {
      const rect = trackRef.current!.getBoundingClientRect();
      const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      return x * duration;
    },
    [duration],
  );

  const onTrackMove = (e: React.MouseEvent) => {
    if (!trackRef.current) return;
    const t = timeFromEvent(e);
    if (dragging) onSeek(t);
    else onHover(t);
  };
  const onTrackLeave = () => {
    if (!dragging) onHover(null);
  };
  const onTrackDown = (e: React.MouseEvent) => {
    setDragging(true);
    onSeek(timeFromEvent(e));
    onHover(null);
  };

  useEffect(() => {
    if (!dragging) return;
    const onUp = () => setDragging(false);
    const onMove = (e: MouseEvent) => {
      if (!trackRef.current) return;
      onSeek(timeFromEvent(e));
    };
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
    };
  }, [dragging, timeFromEvent, onSeek]);

  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const fmt = (t: number) => {
    const total = Math.max(0, t);
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    const cs = Math.floor((total * 100) % 100);
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  const isLight = variant === 'light';
  const barStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 16px',
    background: isLight ? 'transparent' : 'rgba(20,20,20,0.92)',
    borderTop: isLight ? `1px solid ${HAIR}` : '1px solid rgba(255,255,255,0.08)',
    width: '100%',
    color: isLight ? INK : '#f6f4ef',
    fontFamily: DISPLAY,
    userSelect: 'none',
    flexShrink: 0,
  };
  const fg = isLight ? INK : '#f6f4ef';
  const fgDim = isLight ? INK3 : 'rgba(246,244,239,0.55)';

  return (
    <div style={barStyle}>
      <IconButton onClick={onReset} title="Return to start (0)" variant={variant}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 2v10M12 2L5 7l7 5V2z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>
      <IconButton onClick={onPlayPause} title="Play/pause (space)" variant={variant}>
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="3" y="2" width="3" height="10" fill="currentColor" />
            <rect x="8" y="2" width="3" height="10" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 2l9 5-9 5V2z" fill="currentColor" />
          </svg>
        )}
      </IconButton>

      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          width: 64,
          textAlign: 'right',
          color: fg,
        }}
      >
        {fmt(time)}
      </div>

      <div
        ref={trackRef}
        onMouseMove={onTrackMove}
        onMouseLeave={onTrackLeave}
        onMouseDown={onTrackDown}
        style={{
          flex: 1,
          height: 22,
          position: 'relative',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 2,
            background: isLight ? 'rgba(26,26,26,0.12)' : 'rgba(255,255,255,0.12)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: `${pct}%`,
            height: 2,
            background: fg,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: `${pct}%`,
            top: '50%',
            width: 10,
            height: 10,
            marginLeft: -5,
            marginTop: -5,
            background: fg,
            borderRadius: 5,
          }}
        />
      </div>

      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          width: 64,
          textAlign: 'left',
          color: fgDim,
        }}
      >
        {fmt(duration)}
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  variant = 'dark',
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  variant?: 'dark' | 'light';
}) {
  const [hover, setHover] = useState(false);
  const isLight = variant === 'light';
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      type="button"
      style={{
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: isLight
          ? hover
            ? 'rgba(26,26,26,0.06)'
            : 'transparent'
          : hover
            ? 'rgba(255,255,255,0.12)'
            : 'rgba(255,255,255,0.04)',
        border: isLight ? `1px solid ${HAIR}` : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 5.5,
        color: isLight ? INK : '#f6f4ef',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms',
      }}
    >
      {children}
    </button>
  );
}

// ── Stage (fullscreen) ──────────────────────────────────────────────────────
function StageFullscreen() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = usePlayhead(playing, 0, PERSIST_KEY);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') {
        setTime((t) => clamp(t - (e.shiftKey ? 1 : 0.1), 0, DURATION));
      } else if (e.code === 'ArrowRight') {
        setTime((t) => clamp(t + (e.shiftKey ? 1 : 0.1), 0, DURATION));
      } else if (e.key === '0' || e.code === 'Home') {
        setTime(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTime]);

  const displayTime = hoverTime != null ? hoverTime : time;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0a0a0a',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <Canvas time={displayTime} playing={playing} containerRef={stageRef} />
      </div>
      <div style={{ width: '100%', maxWidth: 680, alignSelf: 'center', margin: '12px auto' }}>
        <PlaybackBar
          time={displayTime}
          duration={DURATION}
          playing={playing}
          onPlayPause={() => setPlaying((p) => !p)}
          onReset={() => setTime(0)}
          onSeek={(t) => setTime(t)}
          onHover={(t) => setHoverTime(t)}
        />
      </div>
    </div>
  );
}

// ── Embed (inline 16:9, autoplay, click-to-pause) ───────────────────────────
function EmbedShell({ autoplay = true, restartOnView = true }: { autoplay?: boolean; restartOnView?: boolean }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(autoplay);
  const [time, setTime] = usePlayhead(playing, 0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!restartOnView) return;
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            setPlaying(true);
          } else {
            setPlaying(false);
          }
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [restartOnView]);

  const displayTime = hoverTime != null ? hoverTime : time;

  return (
    <div
      ref={wrapRef}
      style={{
        width: '100%',
        background: PAPER,
        border: `1px solid ${INK}`,
        borderRadius: 5.5,
        boxShadow: '0 18px 40px rgba(26,26,26,0.18)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: `${STAGE_W} / ${STAGE_H}`,
          background: PAPER,
          overflow: 'hidden',
          cursor: 'pointer',
        }}
        onClick={() => setPlaying((p) => !p)}
        role="button"
        aria-label={playing ? 'Pause video' : 'Play video'}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.code === 'Space' || e.code === 'Enter') {
            e.preventDefault();
            setPlaying((p) => !p);
          }
        }}
      >
        {visible && (
          <Canvas time={displayTime} playing={playing} containerRef={stageRef} />
        )}

        {!playing && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                width: 84,
                height: 84,
                borderRadius: 42,
                background: 'rgba(26,26,26,0.92)',
                color: PAPER,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 20px 50px rgba(26,26,26,0.35)',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 14 14" fill="none">
                <path d="M3 2l9 5-9 5V2z" fill="currentColor" />
              </svg>
            </div>
          </div>
        )}
      </div>

      <PlaybackBar
        time={displayTime}
        duration={DURATION}
        playing={playing}
        onPlayPause={() => setPlaying((p) => !p)}
        onReset={() => {
          setTime(0);
          setPlaying(true);
        }}
        onSeek={(t) => setTime(t)}
        onHover={(t) => setHoverTime(t)}
        variant="light"
      />
    </div>
  );
}

// ── Public entries ──────────────────────────────────────────────────────────
export function Video() {
  return <StageFullscreen />;
}

export function VideoEmbed({ autoplay = true }: { autoplay?: boolean }) {
  return <EmbedShell autoplay={autoplay} />;
}

// Used by the offscreen renderer (puppeteer): renders a single deterministic
// frame at the given time, no autoplay, no controls, fixed 1920×1080.
export function VideoFrame({ time }: { time: number }) {
  const ctx = useMemo<TimelineCtx>(
    () => ({ time: clamp(time, 0, DURATION), duration: DURATION, playing: false }),
    [time],
  );
  return (
    <div
      style={{
        width: STAGE_W,
        height: STAGE_H,
        background: PAPER,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <TimelineContext.Provider value={ctx}>
        <Scenes />
      </TimelineContext.Provider>
    </div>
  );
}
