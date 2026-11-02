// shared/lib/snowflake.ts
//
// Whether some text is a Discord ID. The dashboard falls back to plain text boxes
// when it can't load a list of roles or channels, and what gets typed there isn't
// always an ID: production has seen a role's name and a pasted channel link. Used
// by the boxes, by the API before it stores anything, and by the bot on lists saved
// before the API checked.

/** Discord IDs run 17-19 digits today; the range is loose on purpose. */
const SNOWFLAKE = /^\d{15,25}$/;

export function isSnowflake(text: string): boolean {
  return SNOWFLAKE.test(text);
}

export function onlySnowflakes(texts: readonly string[]): string[] {
  return texts.filter((text) => isSnowflake(text));
}
