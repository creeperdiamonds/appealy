// web/src/components/ServerBanned.tsx
//
// Guild-ban treatment for the switcher in App.tsx.
//
// A banned server stays in the list. Filtering it out is simpler and wrong:
// the owner sees a server disappear, concludes the bot broke, and opens a
// ticket about the disappearance instead of reading the ban. Visible, marked,
// appealable — and everything else they manage keeps working.
//
// Selecting a banned server opens the appeal sheet instead of switching to
// it, because there is nothing to configure. The switch is refused at the
// source rather than by rendering a console full of disabled controls.

import { useEffect, useRef } from "react";
import { AppealForm } from "../pages/Banned";
import type { PublicBan } from "../../../shared/schema/platformBans";

export interface BannableGuild {
  id: string;
  name: string;
  iconUrl?: string | null;
  banned?: boolean;
  ban?: PublicBan | null;
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The crossed-out avatar. One SVG, no icon dependency. */
export function BannedAvatar({ src, alt, size = 40 }: { src?: string | null; alt: string; size?: number }) {
  return (
    <span className="banned-avatar" style={{ width: size, height: size }}>
      {src ? <img src={src} alt={alt} width={size} height={size} /> : <span className="avatar-fallback" />}
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
        <line x1="9" y1="9" x2="31" y2="31" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="31" y1="9" x2="9" y2="31" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function GuildOption({
  guild,
  active,
  onSelect,
}: {
  guild: BannableGuild;
  active: boolean;
  onSelect: (g: BannableGuild) => void;
}) {
  const banned = !!guild.banned;
  return (
    <button
      className={`guild-option${active ? " is-active" : ""}${banned ? " is-banned" : ""}`}
      onClick={() => onSelect(guild)}
      aria-label={banned ? `${guild.name} — banned, open appeal` : guild.name}
    >
      {banned ? (
        <BannedAvatar src={guild.iconUrl} alt="" size={36} />
      ) : (
        <img className="guild-icon" src={guild.iconUrl ?? undefined} alt="" width={36} height={36} />
      )}
      <span className="guild-option-body">
        <span className="guild-name">{guild.name}</span>
        <span className={banned ? "guild-sub is-act" : "guild-sub dim"}>
          {banned ? "Banned · appeal" : "Managed"}
        </span>
      </span>
    </button>
  );
}

export function ServerBanSheet({
  guild,
  onClose,
}: {
  guild: BannableGuild | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!guild) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guild, onClose]);

  if (!guild?.ban) return null;
  const ban = guild.ban;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ban-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <BannedAvatar src={guild.iconUrl} alt="" size={40} />
          <div>
            <h2 id="ban-sheet-title">{guild.name}</h2>
            <span className="ban-tag">Server banned</span>
          </div>
          <button ref={closeRef} className="sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <dl className="ban-facts">
          {(
            [
              ["Reason", ban.reasonPublic],
              ["Banned on", formatDay(ban.createdAt)],
              ["Ends", ban.expiresAt ? formatDay(ban.expiresAt) : "Does not expire"],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="ban-fact">
              <dt className="eyebrow">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <p className="dim">
          Appealy won't respond in this server and its settings are locked. Your other servers
          aren't affected. Anyone with Manage Server can appeal.
        </p>

        <AppealForm ban={ban} subject="guild" />

        <div className="dim ban-ref">ref {ban.id.slice(0, 8)}</div>
      </div>
    </div>
  );
}
