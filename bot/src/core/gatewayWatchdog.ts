// bot/src/core/gatewayWatchdog.ts
//
// Notices when the gateway connection is stuck reconnecting, so the process
// can restart instead of limping along.
//
// What happened: on 2026-11-13 a network blip dropped the connection, and
// while reconnecting Discordeno identified twice (Discord closed with 4005,
// "already authenticated"). From then on the shard closed with code 1000 and
// resumed every ~25 seconds, for five and a half days, until a deploy
// restarted the process. Each gap is a moment where button clicks can arrive
// late and show "This interaction failed". The library's own retry never got
// out of it; a fresh process did at once.
//
// So this counts the different minutes that had a disconnect. A blip is a
// burst inside one or two minutes, however many retries it makes, and
// Discord's routine reconnects come hours apart. The stuck loop touches
// nearly every minute, and trips this in about five.
//
// Pure (the caller passes the time) so it can be tested.

/** How far back to look. */
const WINDOW_MS = 10 * 60_000;
/** How many different minutes inside the window must have had a disconnect. */
const MINUTES_TO_TRIP = 5;

export interface GatewayWatchdog {
  /** Records one disconnect. True when the connection looks stuck. */
  recordDisconnect(now: number): boolean;
}

export function createGatewayWatchdog(): GatewayWatchdog {
  const minutes: number[] = [];
  return {
    recordDisconnect(now) {
      const minute = Math.floor(now / 60_000);
      if (minutes[minutes.length - 1] !== minute) minutes.push(minute);
      const oldest = Math.floor((now - WINDOW_MS) / 60_000);
      while (minutes.length && minutes[0] <= oldest) minutes.shift();
      return minutes.length >= MINUTES_TO_TRIP;
    },
  };
}
