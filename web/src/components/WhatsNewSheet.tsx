// web/src/components/WhatsNewSheet.tsx
//
// "What's new": recent releases, newest first, each item with a way to the
// screen it's about. Opens by itself for 48 hours after a release (see
// lib/whatsNew.ts), and any time from the menu or /dashboard/#whats-new.

import { Sheet } from "./ui";
import { t as tr } from "../lib/i18n";
import { RELEASES, local, releaseDate, type Release } from "../lib/whatsNew";

export default function WhatsNewSheet({
  onClose,
  onOpenView,
}: {
  onClose: () => void;
  onOpenView: (view: string, section?: string) => void;
}) {
  const [newest, ...earlier] = RELEASES;
  return (
    <Sheet title={tr("What's new")} onClose={onClose}>
      <div className="whats-new">
        {newest && <ReleaseNotes release={newest} onOpenView={onOpenView} featured />}
        {earlier.length > 0 && (
          <>
            <h3 className="eyebrow whats-new-earlier">{tr("Earlier")}</h3>
            {earlier.map((release) => (
              <ReleaseNotes key={release.publishedAt} release={release} onOpenView={onOpenView} />
            ))}
          </>
        )}
        <div className="whats-new-foot">
          <button className="btn btn-primary" onClick={onClose}>
            {tr("Got it")}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function ReleaseNotes({
  release,
  onOpenView,
  featured = false,
}: {
  release: Release;
  onOpenView: (view: string, section?: string) => void;
  featured?: boolean;
}) {
  return (
    <section className={featured ? "whats-new-release is-featured" : "whats-new-release"}>
      <header>
        <span className="dim whats-new-date">{releaseDate(release)}</span>
        <h3>{local(release.title)}</h3>
      </header>
      <ul className="whats-new-items">
        {release.items.map((item) => (
          <li key={item.title.en}>
            <strong>{local(item.title)}</strong>
            <p className="dim">{local(item.body)}</p>
            {item.view && item.action && (
              <button className="btn btn-sm" onClick={() => onOpenView(item.view!, item.section)}>
                {local(item.action)} →
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
