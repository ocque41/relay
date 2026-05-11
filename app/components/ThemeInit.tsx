'use client';

import { useEffect } from 'react';
import { initTheme } from '../theme';

export function ThemeInit() {
  useEffect(() => {
    initTheme();
  }, []);
  return null;
}
