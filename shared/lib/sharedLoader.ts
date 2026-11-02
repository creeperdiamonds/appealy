// shared/lib/sharedLoader.ts
//
// One request for everyone who wants the same thing at the same moment.
//
// RolePicker fetches its own list, and the form editor shows six of them, so
// opening a form asked the bot for the same role list six times at once. On a
// cold cache each of those was its own call to Discord, queued behind the others,
// and the last few ran past the API's two-second limit. Nothing is kept once the
// answer arrives: the bot already caches the list, and this only has to stop a
// page asking for it several times over.
//
// Plain functions rather than a hook, so it can be tested here without a browser.

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * @param retryDelaysMs How long to wait before each retry. Callers only hear about
 *   a failure once these have run out, so one slow answer doesn't reach the page.
 */
export function sharedLoader<T>(
  load: (key: string) => Promise<T>,
  retryDelaysMs: readonly number[] = [],
): (key: string) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();

  async function withRetries(key: string): Promise<T> {
    for (const delay of retryDelaysMs) {
      try {
        return await load(key);
      } catch {
        await wait(delay);
      }
    }
    return load(key);
  }

  return (key) => {
    const running = inFlight.get(key);
    if (running) return running;
    const started = withRetries(key).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };
}
