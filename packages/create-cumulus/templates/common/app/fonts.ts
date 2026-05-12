import localFont from 'next/font/local';
import { JetBrains_Mono } from 'next/font/google';

export const jakarta = localFont({
  src: [
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-ExtraLight.ttf', weight: '200', style: 'normal' },
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-Light.ttf',      weight: '300', style: 'normal' },
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-Regular.ttf',    weight: '400', style: 'normal' },
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-Medium.ttf',     weight: '500', style: 'normal' },
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-SemiBold.ttf',   weight: '600', style: 'normal' },
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-Bold.ttf',       weight: '700', style: 'normal' },
    { path: '../public/fonts/PlusJakartaSans/PlusJakartaSans-ExtraBold.ttf',  weight: '800', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
});

export const jetbrainsMono = JetBrains_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});
