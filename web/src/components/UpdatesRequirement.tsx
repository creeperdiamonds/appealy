// web/src/components/UpdatesRequirement.tsx
//
// Where this server gets Appealy's updates (api/src/routes/updates.ts).
// Wraps the dashboard's pages:
//
//   following already, or self-hosted   the pages, nothing else
//   not yet, before the deadline         a notice with the picker, then the pages
//   not yet, after the deadline          the picker instead of the pages
//
// Only the dashboard waits. Applications, appeals and tickets keep working in
// the server, because members shouldn't pay for a setting only an admin can
// change. If the status can't be loaded the pages show: a hiccup on our side
// must never lock anyone out.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type UpdatesStatus } from "../lib/api";
import { ChannelPicker, useGuildChannels } from "./ChannelPicker";
import { Banner, Panel } from "./ui";

/** Text and announcement channels: what a follow can post into. */
const FOLLOWABLE = [0, 5];

/** bypass: pages that always open, like billing, so nobody is locked out of their plan. */
export function UpdatesRequirement({
  guildId,
  bypass = false,
  children,
}: {
  guildId: string;
  bypass?: boolean;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<UpdatesStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.updates(guildId));
    } catch {
      setStatus(null);
    }
  }, [guildId]);

  useEffect(() => {
    setStatus(null);
    void load();
  }, [load]);

  if (!status || !status.asked || status.following) return <>{children}</>;

  const deadline = new Date(status.requiredFrom).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  if (status.required && !bypass) {
    return (
      <Panel eyebrow="One step first" title="Pick a channel for Appealy's updates">
        <p>
          Appealy now sends its changelogs and announcements to every server, so you hear about new
          features and fixes, and about anything you need to change. Pick a channel for them to
          go to. The dashboard opens once it's set.
        </p>
        <p className="dim">
          Your applications, appeals and tickets kept working the whole time. Only this dashboard
          waits.
        </p>
        <UpdatesPicker guildId={guildId} onDone={load} />
      </Panel>
    );
  }

  if (status.required) return <>{children}</>;

  return (
    <>
      <Banner level="watch" title={`Pick a channel for Appealy's updates by ${deadline}`}>
        Appealy's changelogs and announcements will go to a channel in your server, so you hear
        about new features, fixes and anything you need to change. You don't need to join another
        server: Discord delivers them by following Appealy's updates channel. From {deadline}, the
        dashboard will ask for this before it opens. Your server's applications keep working
        either way.
        <UpdatesPicker guildId={guildId} onDone={load} />
      </Banner>
      {children}
    </>
  );
}

function UpdatesPicker({ guildId, onDone }: { guildId: string; onDone: () => void }) {
  const { channels, failed } = useGuildChannels(guildId);
  const [channelId, setChannelId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.followUpdates(guildId, channelId);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't set that up. Check Appealy can see the channel and has Manage Webhooks there.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 260px" }}>
        <ChannelPicker
          channels={channels}
          failed={failed}
          types={FOLLOWABLE}
          label="Updates channel"
          hint="Appealy needs Manage Webhooks in it to set up the follow."
          value={channelId}
          onChange={setChannelId}
        />
      </div>
      <button className="btn btn-primary" onClick={save} disabled={!channelId || saving}>
        {saving ? "Setting up…" : "Send updates here"}
      </button>
      {error && (
        <p className="error" role="alert" style={{ flexBasis: "100%", margin: 0 }}>
          {error}
        </p>
      )}
      {/* Open by itself once a follow has failed: by far the likeliest reason
          is the missing permission this walks through. */}
      <WebhooksGuide key={error ? "failed" : "idle"} open={Boolean(error)} />
    </div>
  );
}

/**
 * Giving Appealy Manage Webhooks in one channel, in three annotated Discord
 * screenshots (built by brand/tutorial-src/make_tutorial.py).
 */
const GUIDE_STEPS = [
  { src: "webhooks-step-1.png", alt: "Hover the channel and click its gear icon, Edit Channel." },
  { src: "webhooks-step-2.png", alt: "In the channel's settings, open Permissions." },
  {
    src: "webhooks-step-3.png",
    alt: "Select Appealy under Roles/Members (add it with + if it isn't there), set Manage Webhooks to the green tick, then save.",
  },
];

function WebhooksGuide({ open }: { open: boolean }) {
  const base = `${import.meta.env.BASE_URL}tutorial/`;
  return (
    <details open={open} style={{ flexBasis: "100%" }}>
      <summary style={{ cursor: "pointer" }}>How do I give Appealy Manage Webhooks?</summary>
      <div style={{ display: "grid", gap: 12, marginTop: 12, maxWidth: 720 }}>
        {GUIDE_STEPS.map((s) => (
          <img
            key={s.src}
            src={base + s.src}
            alt={s.alt}
            loading="lazy"
            style={{ width: "100%", height: "auto", borderRadius: 8 }}
          />
        ))}
      </div>
    </details>
  );
}
