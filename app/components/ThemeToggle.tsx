'use client';

import { useEffect, useState } from 'react';
import { getTheme, setTheme, subscribeTheme, type Theme } from '../theme';

type Surface = 'rail' | 'drawer';

const OPTIONS: { value: Theme; label: string; glyph: string }[] = [
  { value: 'light', label: 'Light theme', glyph: '◐' },
  { value: 'dark', label: 'Dark theme', glyph: '●' },
  { value: 'marquee', label: 'Marquee theme', glyph: '▌' },
  { value: 'system', label: 'Follow system theme', glyph: '⌘' },
];

export function ThemeToggle({ surface }: { surface: Surface }) {
  const [current, setCurrent] = useState<Theme>('system');

  useEffect(() => {
    setCurrent(getTheme());
    return subscribeTheme(setCurrent);
  }, []);

  return (
    <div
      className={`theme-toggle theme-toggle--${surface}`}
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-theme-opt={opt.value}
          aria-label={opt.label}
          aria-pressed={current === opt.value}
          onClick={() => setTheme(opt.value)}
        >
          <span aria-hidden="true">{opt.glyph}</span>
        </button>
      ))}
    </div>
  );
}
