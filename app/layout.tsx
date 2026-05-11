import type { Metadata } from 'next';
import { jakarta, jetbrainsMono } from './fonts';
import { ThemeInit } from './components/ThemeInit';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://relay.cumulush.com'),
  title: 'Relay — signup endpoint for API companies whose users arrive via AI agents',
  description:
    'Let AI coding agents sign your users up to your API. Drop a 20-line webhook into your existing auth. You pay only when the signup makes a real first call.',
  openGraph: {
    type: 'website',
    siteName: 'Relay',
    title: 'Relay — signup endpoint for API companies whose users arrive via AI agents',
    description:
      'When Cursor, Claude Code, or a custom agent needs an API key from you, Relay handles signup, email verification, and key handoff. You pay per delivered signup.',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Relay — signup endpoint for API companies whose users arrive via AI agents',
    description:
      'AI coding agents sign your users up. Drop a webhook. Pay per delivered signup.',
  },
};

// Runs synchronously as the first child of <body> so `data-theme` is set
// before any descendants paint. Set on <html> so the custom-property
// overrides cascade to html itself — otherwise overscroll/rubber-band
// reveals the default light --color-paper behind dark mode.
const themeBootScript = `(function(){try{var k='relay:theme';var s=localStorage.getItem(k);var t=(s==='light'||s==='dark'||s==='marquee'||s==='system')?s:'system';var r=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;document.documentElement.setAttribute('data-theme',r);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ThemeInit />
        {children}
      </body>
    </html>
  );
}
