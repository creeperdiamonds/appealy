// web/src/pages/Support.tsx
//
// Getting help, from inside the thing that needs help.
//
// The marketing site has a support section, but it is the wrong place to read
// when something is already broken: you are signed in, looking at a specific
// server, and the answer usually depends on which of those two facts. This
// page knows both.
//
// The diagnostics block at the bottom is the reason this is a page rather than
// a link in the footer. Nearly every unanswerable bug report is unanswerable
// for the same reason — no server id, no deployment mode, no way to tell
// whether the bot was even in the server. Asking people to find those is how
// you get half of them; printing them with a copy button is how you get all of
// them.

import { useState } from "react";
import { Panel } from "../components/ui";

interface SupportProps {
  guildId: string | null;
  guildName?: string;
  installed?: boolean;
  access?: string;
  mode: "platform" | "self" | "test";
  brandName: string;
  supportUrl: string;
  billingEnabled: boolean;
  onOpenBilling: () => void;
}

const REPO = "https://github.com/creeperdiamonds/appealy";

export default function Support({
  guildId,
  guildName,
  installed,
  access,
  mode,
  brandName,
  supportUrl,
  billingEnabled,
  onOpenBilling,
}: SupportProps) {
  const [copied, setCopied] = useState(false);

  // Deliberately plain text rather than JSON. It gets pasted into a GitHub
  // issue or a Discord message, and a fenced JSON blob is something the
  // reader has to parse before they can read it.
  const diagnostics = [
    `Server:      ${guildName ?? "(none selected)"}`,
    `Server ID:   ${guildId ?? "(none selected)"}`,
    `Bot present: ${installed === undefined ? "unknown" : installed ? "yes" : "NO — not invited"}`,
    `Your access: ${access ?? "unknown"}`,
    `Deployment:  ${mode}`,
    `Console:     ${window.location.origin}`,
    `Browser:     ${navigator.userAgent}`,
    `Captured:    ${new Date().toISOString()}`,
  ].join("\n");

  const copy = () => {
    navigator.clipboard.writeText(diagnostics).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard access can be refused outright — an insecure origin, or a
        // browser policy. Saying so beats a button that silently does nothing;
        // the text is on screen and selectable either way.
        setCopied(false);
        alert("Your browser refused clipboard access. Select the text below and copy it manually.");
      },
    );
  };

  return (
    <>
      <Panel title="Getting help">
        <p className="dim">
          {brandName} is a small project rather than a company with a support desk. That is worth
          saying plainly instead of implying a response time nobody is on call to meet — but every
          route below is real and read by a person.
        </p>
      </Panel>

      <div className="support-grid">
        <Panel title="Something is broken">
          <p className="dim">
            Open an issue. Include what you did, what happened, and the diagnostics below — those
            three things are the difference between a fix and a conversation.
          </p>
          <a className="btn" href={`${REPO}/issues/new`} target="_blank" rel="noreferrer">
            Open an issue
          </a>
        </Panel>

        <Panel title="Is it me, or is it down?">
          <p className="dim">
            The status page is served independently of this console, so it still answers when this
            does not. Check it first — an outage and a misconfiguration look identical from inside
            a Discord server.
          </p>
          <a className="btn" href="/status/" target="_blank" rel="noreferrer">
            Service status
          </a>
        </Panel>

        <Panel title="Setting it up">
          <p className="dim">
            Most setup questions are answered in one of these two. The first covers the hosted
            path, the second running your own instance.
          </p>
          <div className="btn-row">
            <a className="btn" href={`${REPO}/blob/main/SETUP.md`} target="_blank" rel="noreferrer">
              Setup guide
            </a>
            <a className="btn" href={`${REPO}/blob/main/SELF_HOSTING.md`} target="_blank" rel="noreferrer">
              Self-hosting
            </a>
          </div>
        </Panel>

        <Panel title="A security problem">
          <p className="dim">
            Please do not open a public issue for anything exploitable. Private reporting reaches
            the maintainer without publishing the details first.
          </p>
          <a
            className="btn"
            href={`${REPO}/security/advisories/new`}
            target="_blank"
            rel="noreferrer"
          >
            Report privately
          </a>
        </Panel>

        {billingEnabled && (
          <Panel title="Billing and payment">
            <p className="dim">
              Tebex is the merchant of record, so refunds and payment-method problems go through
              their support with your order reference. Refunds are available for 14 days after
              purchase, no reason needed. What a plan actually grants is a different question —
              that one is on the billing screen.
            </p>
            <button className="btn" onClick={onOpenBilling}>
              Open billing
            </button>
          </Panel>
        )}

        <Panel title="Reading the source">
          <p className="dim">
            Every cap, price and rule this console enforces is in the repository. The pricing
            calculator is a single pure function, so what you are charged is readable rather than
            taken on trust.
          </p>
          <div className="btn-row">
            <a className="btn" href={REPO} target="_blank" rel="noreferrer">
              Repository
            </a>
            <a
              className="btn"
              href={`${REPO}/blob/main/shared/schema/pricing.ts`}
              target="_blank"
              rel="noreferrer"
            >
              pricing.ts
            </a>
          </div>
        </Panel>
      </div>

      <Panel
        title="Diagnostics"
        action={
          <button className="btn" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        }
      >
        <p className="dim">
          Paste this into any bug report. It contains no tokens and nothing private — a server id,
          which deployment you are on, and your browser.
        </p>
        <pre className="diagnostics">{diagnostics}</pre>
      </Panel>

      {supportUrl && (
        <Panel title="This deployment">
          <p className="dim">
            Whoever runs this instance has published their own support contact, which is the right
            place for anything specific to it.
          </p>
          <a className="btn" href={supportUrl} target="_blank" rel="noreferrer">
            {supportUrl}
          </a>
        </Panel>
      )}
    </>
  );
}
