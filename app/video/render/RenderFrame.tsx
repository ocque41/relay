'use client';

import { useEffect } from 'react';
import { VideoFrame } from '../Video';

export function RenderFrame({ time }: { time: number }) {
  useEffect(() => {
    document.documentElement.style.background = '#f5f5f5';
    document.body.style.background = '#f5f5f5';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    // Signal to puppeteer that the frame is ready to capture.
    // Wait two RAFs so layout + fonts have a chance to settle.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        (window as unknown as { __frameReady?: boolean }).__frameReady = true;
      }),
    );
  }, [time]);

  return (
    <>
      {/* Hide Next.js dev overlay/indicator so it doesn't leak into screenshots */}
      <style>{`
        nextjs-portal,
        [data-nextjs-toast],
        [data-nextjs-dev-indicator],
        [data-nextjs-dev-overlay],
        #__next-build-watcher,
        #nextjs__container_build_error_label {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `}</style>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          background: '#f5f5f5',
          overflow: 'hidden',
        }}
      >
        <VideoFrame time={time} />
      </div>
    </>
  );
}
