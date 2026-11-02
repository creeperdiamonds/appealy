// web/src/components/IdFields.tsx
//
// For boxes that take Discord IDs as text, which is what the pickers fall back to
// when their list can't be loaded. What gets typed there isn't always an ID:
// production has seen a role's name and a pasted channel link. Saying so here is
// the only chance to explain it, because by the time it has been saved it's a
// review post that never arrived.

import { useEffect, useState } from "react";
import { isSnowflake, onlySnowflakes } from "../../../shared/lib/snowflake";

type IdKind = "role" | "channel" | "category";

/** Says so when a box that wants a Discord ID has something else in it. */
export function NotAnId({ text, kind }: { text: string; kind: IdKind }) {
  if (!text || isSnowflake(text)) return null;
  const copy = `Copy ${kind[0].toUpperCase()}${kind.slice(1)} ID`;
  return (
    <span className="error" role="alert">
      “{text}” isn't a {kind} ID. Turn on Developer Mode in Discord, then right-click the {kind} and
      choose {copy}.
    </span>
  );
}

const split = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/**
 * Several IDs in one box. Held as text because `value` only ever gets real IDs, so
 * it can't show a half-typed one, or the separator just pressed. A saved list that
 * holds something else shows it here too, and it goes on the next edit.
 */
export function IdListField({
  label,
  kind,
  value,
  onChange,
  note,
}: {
  label: string;
  kind: "role" | "channel";
  value: string[];
  onChange: (ids: string[]) => void;
  note: string;
}) {
  const [text, setText] = useState(value.join(", "));

  // Changed from outside, like the page switching to another form.
  const saved = value.join();
  useEffect(() => {
    if (saved !== onlySnowflakes(split(text)).join()) setText(value.join(", "));
    // Only when the value changes: text changing is this box's own doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const notAnId = split(text).find((part) => !isSnowflake(part));

  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <input
        value={text}
        placeholder={kind === "role" ? "Role IDs, comma separated" : "Channel IDs, comma separated"}
        onChange={(e) => {
          setText(e.target.value);
          onChange(onlySnowflakes(split(e.target.value)));
        }}
      />
      {notAnId && <NotAnId text={notAnId} kind={kind} />}
      <span className="dim">{note}</span>
    </label>
  );
}
