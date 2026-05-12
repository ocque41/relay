export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initSentry } = await import('./src/server/sentry');
    initSentry();
  }
}
