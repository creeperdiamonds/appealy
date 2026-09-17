// web/src/lib/feedback.ts
//
// Whether the console has already asked this person for feedback.
//
// Per browser, not per account or per server: the prompt is a small ask shown
// once, and storing it server-side would mean a table, a route and a migration
// for a boolean nobody will ever query. The cost of getting it wrong is that
// someone on a second device sees it twice, which is the same cost as the
// theme preference and is handled the same way.
//
// Nine servers found Appealy without being told about it, and none of their
// owners has ever opened a support ticket. That is the situation this exists
// for: a way to hear from people who have no reason to come looking, without
// DMing anyone who never asked to be contacted.

const KEY = "appealy:feedback-dismissed";

export function feedbackDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Private mode, or site data blocked. Showing the prompt again next visit
    // is a much smaller problem than failing to render the console.
    return false;
  }
}

export function dismissFeedback(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Same as above: the dismissal just does not survive the session.
  }
}
