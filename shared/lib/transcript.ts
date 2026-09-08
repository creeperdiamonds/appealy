// shared/lib/transcript.ts
//
// Rendering a ticket transcript. Pure: messages in, text out, no Discord
// client and no I/O — which is the only reason any of this is testable.
//
// It lives in shared/ rather than in the bot because the input is described
// structurally below rather than imported from discordeno. A renderer that
// needs a live gateway client to exercise is a renderer nobody exercises.

/** The parts of a Discord message a transcript actually reads. */
export interface TranscriptMessage {
  timestamp?: number | null;
  content?: string | null;
  author?: { username?: string | null } | null;
  attachments?: { filename?: string | null }[] | null;
  embeds?: unknown[] | null;
}

export interface RenderOptions {
  /**
   * True when the fetch stopped at a page cap rather than at the start of the
   * channel. The transcript then says so in its own first line, because a
   * partial transcript that does not admit it is worse than no transcript —
   * someone reads it, does not find what they are looking for, and concludes
   * it did not happen.
   */
  truncated?: boolean;
}

/**
 * One line per message, oldest first.
 *
 * A message with no text still gets a line. Previously the renderer emitted
 * `content ?? ""`, so a screenshot — which is the single most common thing
 * anyone posts in a support ticket — became a timestamp, a name, a colon and
 * nothing. The transcript recorded that somebody said nothing, at a moment
 * when they had in fact sent the evidence the whole ticket was about.
 */
export function renderTranscript(
  messages: TranscriptMessage[],
  options: RenderOptions = {},
): string {
  const lines = messages.map((m) => {
    const at = new Date(m.timestamp ?? 0).toISOString();
    const who = m.author?.username ?? "unknown";

    const parts: string[] = [];
    const text = (m.content ?? "").trim();
    if (text) parts.push(text);

    // Filenames, not URLs. Discord's attachment URLs are signed and expire
    // within about a day, so a URL written into a text file is a dead link by
    // the time anyone opens the file. The name is what lets a reader match the
    // line to the file, which is all a transcript can honestly offer.
    const files = (m.attachments ?? [])
      .map((a) => a?.filename)
      .filter((n): n is string => Boolean(n));
    if (files.length) parts.push(`[attached: ${files.join(", ")}]`);

    const embeds = m.embeds?.length ?? 0;
    if (embeds) parts.push(`[${embeds} embed${embeds === 1 ? "" : "s"}]`);

    // Still nothing? Say so, rather than emitting a line that looks like the
    // person typed an empty string.
    if (parts.length === 0) parts.push("[no content]");

    return `[${at}] ${who}: ${parts.join(" ")}`;
  });

  const body = lines.join("\n") || "(no messages)";
  if (!options.truncated) return body;

  return [
    "*** TRUNCATED ***",
    "This ticket had more messages than the transcript limit, so the earliest",
    "ones are not included below. What follows is the most recent portion.",
    "",
    body,
  ].join("\n");
}
