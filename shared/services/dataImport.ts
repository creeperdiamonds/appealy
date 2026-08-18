// shared/services/dataImport.ts
//
// Imports an Appealy export into a different guild.
//
// The counterpart to the export, and a much harder problem than it looks,
// because an export is not portable data — it is data about one specific
// Discord server. Every channel id, role id and message id in it names
// something that exists in the source guild and does not exist in the target.
// Inserting those ids verbatim produces a configuration that looks complete,
// passes every constraint, and silently does nothing: forms logging to a
// channel that isn't there, panels published to a message that never existed,
// role grants naming roles from someone else's server.
//
// So this does three things rather than one:
//
//   1. Re-key everything. New ids for every row, with the references between
//      them rewritten — a panel button pointing at its form, a DM template at
//      its form, the appeal config at the appeal form.
//
//   2. Resolve or surrender every snowflake. An explicit source→target map
//      handles what the caller knows. Anything left is either cleared (where
//      the column allows it) or pointed at a fallback channel (where it does
//      not), and every single one is listed in the report so the admin knows
//      exactly what to reconnect rather than discovering it in production.
//
//   3. Refuse to silently widen access. This is the part worth reading twice.
//      A form gated to a staff role whose id means nothing here would import
//      with an empty gate — which is not a broken form, it is an OPEN one.
//      Anyone could apply to a staff application. So a form that loses a gate
//      it previously had is imported deactivated, and named in the report. The
//      admin turns it back on once the roles are reconnected. The same logic
//      is why a role menu whose options all failed to resolve is skipped
//      rather than imported empty.
//
// WHAT IS DELIBERATELY NOT IMPORTED
//
// Submissions and their answers, tickets, ban appeals, giveaway entries, raid
// lockdowns, gate overrides. These are not configuration — they are things
// people in the SOURCE server wrote and did, much of it about themselves.
// Copying an applicant's answers into an unrelated server because its owner
// happened to be handed a file is not a migration, it is a disclosure. The
// export exists so a server can take its own data with it; that is not the
// same as installing it somewhere else.
//
// Staff permission delegations are excluded for a different reason: they name
// users and roles from the source guild, and importing them would grant
// review access in this guild to whoever those ids happen to be here. An
// import should never be a way to hand someone staff.
//
// Both runtimes call this. The db handle is a parameter rather than an import
// because the bot and the API each construct their own — the same reason the
// export exists twice, which is a duplication this file deliberately does not
// repeat.

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/schema.ts";

type Db = PostgresJsDatabase<typeof schema>;

export interface ImportOptions {
  /** The guild receiving the data. */
  targetGuildId: bigint;
  /**
   * Where anything that must live in a channel goes until it is moved.
   * Required, because forms.logChannelId, panels.channelId,
   * ticketConfigs.channelId, roleMenus.channelId and stickyMessages.channelId
   * are all NOT NULL — there is no "unset" to fall back to.
   */
  fallbackChannelId: bigint;
  /** Who ran the import. Fills the not-null authorship columns. */
  actorId: bigint;
  /**
   * Optional source→target snowflake map, as decimal id strings. Anything
   * present here is translated; anything absent is cleared or defaulted and
   * reported. Callers that can build one should — it is the difference
   * between an import that works and one that needs an afternoon of clicking.
   */
  idMap?: Record<string, string>;
  /**
   * append  — add alongside whatever the target already has.
   * replace — delete the target's existing configuration of the same kinds
   *           first. Destructive, and never the default.
   */
  mode: "append" | "replace";
}

export interface ImportReport {
  /** Rows created, by kind. */
  created: Record<string, number>;
  /** Things that could not be imported at all, and why. */
  skipped: Array<{ kind: string; name: string; why: string }>;
  /** Snowflakes that need an admin's attention, one entry each. */
  reconnect: Array<{
    kind: string;
    name: string;
    field: string;
    sourceId: string;
    action: "pointed at the fallback channel" | "cleared";
  }>;
  /** Forms imported switched off because a gate did not survive. */
  deactivated: Array<{ name: string; why: string }>;
}

/** The subset of an export this importer reads. Everything else is ignored. */
interface ImportPayload {
  exportVersion?: number;
  forms?: unknown[];
  panels?: unknown[];
  dmTemplates?: unknown[];
  formOutcomes?: unknown[];
  ticketConfigs?: unknown[];
  verificationConfig?: unknown | null;
  welcomerConfig?: unknown | null;
  roleMenus?: unknown[];
  antiRaidConfig?: unknown | null;
  quickResponses?: unknown[];
  quickResponseCategories?: unknown[];
  stickyMessages?: unknown[];
  appealConfig?: unknown | null;
}

type Row = Record<string, unknown>;

/** Export rows carry snowflakes as strings, because bigint does not survive JSON. */
function asRows(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : [];
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

class Resolver {
  constructor(
    private map: Record<string, string>,
    private fallbackChannelId: bigint,
    private report: ImportReport,
  ) {}

  /** A snowflake that may be absent. Unmapped becomes null, and is reported. */
  optional(kind: string, name: string, field: string, raw: unknown): bigint | null {
    const id = str(raw);
    if (!id) return null;
    const mapped = this.map[id];
    if (mapped) return BigInt(mapped);
    this.report.reconnect.push({ kind, name, field, sourceId: id, action: "cleared" });
    return null;
  }

  /** A snowflake the column requires. Unmapped lands on the fallback channel. */
  required(kind: string, name: string, field: string, raw: unknown): bigint {
    const id = str(raw);
    if (id) {
      const mapped = this.map[id];
      if (mapped) return BigInt(mapped);
      this.report.reconnect.push({
        kind,
        name,
        field,
        sourceId: id,
        action: "pointed at the fallback channel",
      });
    }
    return this.fallbackChannelId;
  }

  /**
   * A list of role ids. Unmapped entries are dropped rather than kept, since
   * a role id from another server would name a different role here or none.
   * Returns whether anything was lost, because for a gate that matters.
   */
  roleList(raw: unknown): { ids: string[]; lost: number } {
    const source = Array.isArray(raw) ? raw.map(String) : [];
    const ids: string[] = [];
    let lost = 0;
    for (const id of source) {
      const mapped = this.map[id];
      if (mapped) ids.push(mapped);
      else lost++;
    }
    return { ids, lost };
  }
}

export async function importGuildData(
  db: Db,
  payload: ImportPayload,
  options: ImportOptions,
): Promise<ImportReport> {
  const { targetGuildId, fallbackChannelId, actorId, mode } = options;

  const report: ImportReport = { created: {}, skipped: [], reconnect: [], deactivated: [] };
  const resolve = new Resolver(options.idMap ?? {}, fallbackChannelId, report);
  const count = (kind: string, n = 1) => {
    report.created[kind] = (report.created[kind] ?? 0) + n;
  };

  if (mode === "replace") {
    // Ordered so that children go before parents even where the cascade would
    // have handled it — being explicit here means a future schema change that
    // drops a cascade does not quietly turn this into a partial wipe.
    await db.delete(schema.appealConfigs).where(eq(schema.appealConfigs.guildId, targetGuildId));
    await db.delete(schema.panels).where(eq(schema.panels.guildId, targetGuildId));
    await db.delete(schema.forms).where(eq(schema.forms.guildId, targetGuildId));
    await db.delete(schema.ticketConfigs).where(eq(schema.ticketConfigs.guildId, targetGuildId));
    await db.delete(schema.roleMenus).where(eq(schema.roleMenus.guildId, targetGuildId));
    await db.delete(schema.stickyMessages).where(eq(schema.stickyMessages.guildId, targetGuildId));
    await db.delete(schema.quickResponses).where(eq(schema.quickResponses.guildId, targetGuildId));
    await db
      .delete(schema.quickResponseCategories)
      .where(eq(schema.quickResponseCategories.guildId, targetGuildId));
    await db
      .delete(schema.verificationConfigs)
      .where(eq(schema.verificationConfigs.guildId, targetGuildId));
    await db.delete(schema.welcomerConfigs).where(eq(schema.welcomerConfigs.guildId, targetGuildId));
    await db.delete(schema.antiRaidConfigs).where(eq(schema.antiRaidConfigs.guildId, targetGuildId));
  }

  // --- forms and their questions ------------------------------------------
  // formIdMap is what every later reference is rewritten through.
  const formIdMap = new Map<string, string>();

  for (const form of asRows(payload.forms)) {
    const name = str(form.name) ?? "(unnamed form)";
    const gates = resolve.roleList(form.requiredRoleIds);
    const blocks = resolve.roleList(form.blacklistedRoleIds);

    // The safety rule from the header. A gate that existed and no longer does
    // is an open door, not a missing setting.
    const lostAGate = gates.lost > 0 || blocks.lost > 0;

    // The reviewer whitelist needs the opposite treatment to a gate. A gate
    // that fails open lets the wrong people IN, so the form is deactivated; a
    // whitelist that fails empty locks everyone OUT, so it is switched off and
    // the form falls back to normal staff permissions.
    //
    // Member ids carry over verbatim, unlike roles. A snowflake identifies a
    // person globally rather than per-server, so a named reviewer who is in
    // both servers stays valid — and one who is not is simply never matched,
    // which costs nothing. Roles have to be remapped because a role id means
    // nothing outside the server that created it.
    const reviewerRoles = resolve.roleList(form.reviewerRoleIds);
    const reviewerUsers = asRows(form.reviewerUserIds).length
      ? (form.reviewerUserIds as unknown[]).map(String)
      : [];
    const whitelistRequested = Boolean(form.reviewerWhitelistEnabled ?? false);
    const whitelistUsable = reviewerRoles.ids.length > 0 || reviewerUsers.length > 0;

    const [created] = await db
      .insert(schema.forms)
      .values({
        guildId: targetGuildId,
        kind: (form.kind as "application" | "appeal") ?? "application",
        name,
        description: str(form.description),
        applicationType:
          (form.applicationType as "in_server" | "direct_message") ?? "in_server",
        logChannelId: resolve.required("form", name, "logChannelId", form.logChannelId),
        acceptedChannelId: resolve.optional("form", name, "acceptedChannelId", form.acceptedChannelId),
        deniedChannelId: resolve.optional("form", name, "deniedChannelId", form.deniedChannelId),
        // Switched off when a gate was lost, so nobody can apply to a staff
        // form through a door the import left open.
        active: lostAGate ? false : Boolean(form.active ?? true),
        cooldownSeconds: Number(form.cooldownSeconds ?? 0),
        allowMultiplePending: Boolean(form.allowMultiplePending ?? false),
        requiredRoleIds: gates.ids,
        blacklistedRoleIds: blocks.ids,
        grantRoleIds: resolve.roleList(form.grantRoleIds).ids,
        removeRoleIds: resolve.roleList(form.removeRoleIds).ids,
        deniedGrantRoleIds: resolve.roleList(form.deniedGrantRoleIds).ids,
        denyRemoveRoleIds: resolve.roleList(form.denyRemoveRoleIds).ids,
        pendingRoleIds: resolve.roleList(form.pendingRoleIds).ids,
        removeRolesOnSubmitIds: resolve.roleList(form.removeRolesOnSubmitIds).ids,
        pingRoleIds: resolve.roleList(form.pingRoleIds).ids,
        reviewerWhitelistEnabled: whitelistRequested && whitelistUsable,
        reviewerUserIds: reviewerUsers,
        reviewerRoleIds: reviewerRoles.ids,
      })
      .returning({ id: schema.forms.id });

    formIdMap.set(String(form.id), created.id);
    count("forms");

    if (whitelistRequested && !whitelistUsable) {
      report.deactivated.push({
        name: `${name} (reviewer whitelist)`,
        why:
          "every whitelisted reviewer role came from the source server and could not be mapped, " +
          "and no whitelisted members were listed — leaving it on would have meant nobody could " +
          "review this form, so it fell back to your normal staff permissions",
      });
    }

    if (lostAGate) {
      report.deactivated.push({
        name,
        why:
          "role gating referenced roles from the source server that could not be mapped — " +
          "importing it active would have made it open to everyone",
      });
    }

    for (const q of asRows(form.questions)) {
      await db.insert(schema.questions).values({
        formId: created.id,
        label: str(q.label) ?? "",
        placeholder: str(q.placeholder),
        type: (q.type as never) ?? "short",
        required: Boolean(q.required ?? true),
        sortOrder: Number(q.sortOrder ?? 0),
        options: (q.options as never) ?? null,
        minLength: q.minLength === null || q.minLength === undefined ? null : Number(q.minLength),
        maxLength: q.maxLength === null || q.maxLength === undefined ? null : Number(q.maxLength),
        validationType: (q.validationType as never) ?? undefined,
        validationPattern: str(q.validationPattern),
        validationErrorMessage: str(q.validationErrorMessage),
      });
      count("questions");
    }
  }

  // --- form outcomes -------------------------------------------------------
  for (const outcome of asRows(payload.formOutcomes)) {
    const targetFormId = formIdMap.get(String(outcome.formId));
    if (!targetFormId) continue; // its form was not in this export

    const label = str(outcome.label) ?? "(unnamed outcome)";
    await db.insert(schema.formOutcomes).values({
      formId: targetFormId,
      decision: (outcome.decision as "accept" | "deny") ?? "accept",
      label,
      description: str(outcome.description),
      emoji: str(outcome.emoji),
      requiresConfirm: Boolean(outcome.requiresConfirm ?? false),
      grantRoleIds: resolve.roleList(outcome.grantRoleIds).ids,
      removeRoleIds: resolve.roleList(outcome.removeRoleIds).ids,
      message: str(outcome.message),
      logChannelId: resolve.optional("outcome", label, "logChannelId", outcome.logChannelId),
      minStaffLevel: Number(outcome.minStaffLevel ?? 0),
      position: Number(outcome.position ?? 0),
    });
    count("formOutcomes");
  }

  // --- DM templates --------------------------------------------------------
  for (const t of asRows(payload.dmTemplates)) {
    const targetFormId = formIdMap.get(String(t.formId));
    if (!targetFormId) continue;
    await db.insert(schema.dmTemplates).values({
      formId: targetFormId,
      type: (t.type as never) ?? "submission",
      enabled: Boolean(t.enabled ?? true),
      title: str(t.title),
      body: str(t.body) ?? "",
      color: t.color === null || t.color === undefined ? null : Number(t.color),
    });
    count("dmTemplates");
  }

  // --- panels and their buttons -------------------------------------------
  for (const panel of asRows(payload.panels)) {
    const name = str(panel.title) ?? "(untitled panel)";
    const [created] = await db
      .insert(schema.panels)
      .values({
        guildId: targetGuildId,
        title: name,
        description: str(panel.description),
        color: panel.color === null || panel.color === undefined ? null : Number(panel.color),
        imageUrl: str(panel.imageUrl),
        thumbnailUrl: str(panel.thumbnailUrl),
        footerText: str(panel.footerText),
        displayType: (panel.displayType as "buttons" | "dropdown") ?? "buttons",
        channelId: resolve.required("panel", name, "channelId", panel.channelId),
        // Never carried over: the message it refers to lives in the source
        // guild. Published state has to be re-established by publishing here.
        messageId: null,
        published: false,
      })
      .returning({ id: schema.panels.id });

    count("panels");

    for (const b of asRows(panel.buttons)) {
      const targetFormId = formIdMap.get(String(b.formId));
      if (!targetFormId) {
        report.skipped.push({
          kind: "panel button",
          name: str(b.label) ?? "(unlabelled)",
          why: "the form it opens was not part of this export",
        });
        continue;
      }
      await db.insert(schema.panelButtons).values({
        panelId: created.id,
        formId: targetFormId,
        label: str(b.label) ?? "Apply",
        emoji: str(b.emoji),
        style: (b.style as never) ?? "primary",
        sortOrder: Number(b.sortOrder ?? 0),
      });
      count("panelButtons");
    }
  }

  // --- appeal config -------------------------------------------------------
  if (payload.appealConfig) {
    const cfg = payload.appealConfig as Row;
    const targetFormId = cfg.formId ? formIdMap.get(String(cfg.formId)) : undefined;
    await db
      .insert(schema.appealConfigs)
      .values({
        guildId: targetGuildId,
        // Left unset rather than pointed anywhere if its form is missing —
        // an appeal config aimed at the wrong form is worse than none.
        formId: targetFormId ?? null,
        enabled: targetFormId ? Boolean(cfg.enabled ?? false) : false,
        dmOnBanEnabled: Boolean(cfg.dmOnBanEnabled ?? true),
        dmOnBanNote: str(cfg.dmOnBanNote),
        autoUnbanOnAccept: Boolean(cfg.autoUnbanOnAccept ?? true),
      })
      .onConflictDoNothing();
    count("appealConfig");
  }

  // --- ticket configs ------------------------------------------------------
  for (const cfg of asRows(payload.ticketConfigs)) {
    const name = str(cfg.name) ?? "(unnamed ticket type)";
    await db.insert(schema.ticketConfigs).values({
      guildId: targetGuildId,
      name,
      buttonLabel: str(cfg.buttonLabel) ?? "Open a ticket",
      buttonEmoji: str(cfg.buttonEmoji),
      channelId: resolve.required("ticket type", name, "channelId", cfg.channelId),
      categoryId: resolve.optional("ticket type", name, "categoryId", cfg.categoryId),
      transcriptChannelId: resolve.optional(
        "ticket type",
        name,
        "transcriptChannelId",
        cfg.transcriptChannelId,
      ),
      channelType: (cfg.channelType as never) ?? undefined,
      supportRoleIds: resolve.roleList(cfg.supportRoleIds).ids,
      pingRoleIds: resolve.roleList(cfg.pingRoleIds).ids,
      welcomeMessage: str(cfg.welcomeMessage),
      ticketNameFormat: str(cfg.ticketNameFormat) ?? undefined,
      maxOpenPerUser: Number(cfg.maxOpenPerUser ?? 1),
      leaveAction: (cfg.leaveAction as never) ?? undefined,
      transcriptOnClose: Boolean(cfg.transcriptOnClose ?? false),
      creatorCanClose: Boolean(cfg.creatorCanClose ?? true),
      claimingEnabled: Boolean(cfg.claimingEnabled ?? false),
      ratingEnabled: Boolean(cfg.ratingEnabled ?? false),
      active: Boolean(cfg.active ?? true),
    });
    count("ticketConfigs");
  }

  // --- role menus ----------------------------------------------------------
  for (const menu of asRows(payload.roleMenus)) {
    const name = str(menu.title) ?? "(untitled role menu)";
    const options = asRows(menu.options);

    // Resolved first: a menu whose options all point at roles that mean
    // nothing here would import as an empty dropdown that does nothing.
    const resolved = options
      .map((o) => ({ o, roleId: resolve.roleList([o.roleId]).ids[0] }))
      .filter((r): r is { o: Row; roleId: string } => Boolean(r.roleId));

    if (options.length > 0 && resolved.length === 0) {
      report.skipped.push({
        kind: "role menu",
        name,
        why: "none of its roles could be mapped to this server, so it would have been an empty menu",
      });
      continue;
    }

    const [created] = await db
      .insert(schema.roleMenus)
      .values({
        guildId: targetGuildId,
        title: name,
        description: str(menu.description),
        channelId: resolve.required("role menu", name, "channelId", menu.channelId),
        selectionMode: (menu.selectionMode as "single" | "multiple") ?? "multiple",
        messageId: null,
        published: false,
      })
      .returning({ id: schema.roleMenus.id });
    count("roleMenus");

    for (const r of resolved) {
      await db.insert(schema.roleMenuOptions).values({
        menuId: created.id,
        roleId: BigInt(r.roleId),
        label: str(r.o.label) ?? "Role",
        description: str(r.o.description),
        emoji: str(r.o.emoji),
        sortOrder: Number(r.o.sortOrder ?? 0),
      });
      count("roleMenuOptions");
    }
  }

  // --- single-row configs --------------------------------------------------
  if (payload.verificationConfig) {
    const cfg = payload.verificationConfig as Row;
    await db
      .insert(schema.verificationConfigs)
      .values({
        guildId: targetGuildId,
        enabled: Boolean(cfg.enabled ?? false),
        method: (cfg.method as never) ?? undefined,
        channelId: resolve.optional("verification", "config", "channelId", cfg.channelId),
        messageId: null,
        verifiedRoleId: resolve.optional("verification", "config", "verifiedRoleId", cfg.verifiedRoleId),
        unverifiedRoleId: resolve.optional(
          "verification",
          "config",
          "unverifiedRoleId",
          cfg.unverifiedRoleId,
        ),
        panelTitle: str(cfg.panelTitle) ?? undefined,
        panelDescription: str(cfg.panelDescription) ?? undefined,
        kickUnverifiedAfterSeconds:
          cfg.kickUnverifiedAfterSeconds === null || cfg.kickUnverifiedAfterSeconds === undefined
            ? null
            : Number(cfg.kickUnverifiedAfterSeconds),
      })
      .onConflictDoNothing();
    count("verificationConfig");
  }

  if (payload.welcomerConfig) {
    const cfg = payload.welcomerConfig as Row;
    await db
      .insert(schema.welcomerConfigs)
      .values({
        guildId: targetGuildId,
        joinEnabled: Boolean(cfg.joinEnabled ?? false),
        joinChannelId: resolve.optional("welcomer", "config", "joinChannelId", cfg.joinChannelId),
        joinMessage: str(cfg.joinMessage),
        joinDmEnabled: Boolean(cfg.joinDmEnabled ?? false),
        joinDmMessage: str(cfg.joinDmMessage),
        joinEmbedColor:
          cfg.joinEmbedColor === null || cfg.joinEmbedColor === undefined
            ? null
            : Number(cfg.joinEmbedColor),
        joinImageUrl: str(cfg.joinImageUrl),
        autoRoleIds: resolve.roleList(cfg.autoRoleIds).ids,
        leaveEnabled: Boolean(cfg.leaveEnabled ?? false),
        leaveChannelId: resolve.optional("welcomer", "config", "leaveChannelId", cfg.leaveChannelId),
        leaveMessage: str(cfg.leaveMessage),
      })
      .onConflictDoNothing();
    count("welcomerConfig");
  }

  if (payload.antiRaidConfig) {
    const cfg = payload.antiRaidConfig as Row;
    await db
      .insert(schema.antiRaidConfigs)
      .values({
        guildId: targetGuildId,
        enabled: Boolean(cfg.enabled ?? false),
        joinThreshold: Number(cfg.joinThreshold ?? 10),
        windowSeconds: Number(cfg.windowSeconds ?? 60),
        action: (cfg.action as never) ?? "alert",
        alertChannelId: resolve.optional("anti-raid", "config", "alertChannelId", cfg.alertChannelId),
        alertRoleIds: resolve.roleList(cfg.alertRoleIds).ids,
        autoLockdownExpiresAfterSeconds: Number(cfg.autoLockdownExpiresAfterSeconds ?? 1800),
      })
      .onConflictDoNothing();
    count("antiRaidConfig");
  }

  // --- quick responses -----------------------------------------------------
  const categoryIdMap = new Map<string, string>();
  for (const cat of asRows(payload.quickResponseCategories)) {
    const [created] = await db
      .insert(schema.quickResponseCategories)
      .values({
        guildId: targetGuildId,
        name: str(cat.name) ?? "(unnamed)",
        sortOrder: Number(cat.sortOrder ?? 0),
      })
      .returning({ id: schema.quickResponseCategories.id });
    categoryIdMap.set(String(cat.id), created.id);
    count("quickResponseCategories");
  }

  for (const qr of asRows(payload.quickResponses)) {
    await db.insert(schema.quickResponses).values({
      guildId: targetGuildId,
      categoryId: qr.categoryId ? categoryIdMap.get(String(qr.categoryId)) ?? null : null,
      title: str(qr.title) ?? "(unnamed)",
      body: str(qr.body) ?? "",
      // Authorship moves to whoever ran the import; the original author is a
      // user in another server.
      createdBy: actorId,
    });
    count("quickResponses");
  }

  // --- sticky messages -----------------------------------------------------
  for (const sticky of asRows(payload.stickyMessages)) {
    // Sticky messages have no name of their own; the first words of the
    // content are what an admin will recognise it by in the report.
    const name = (str(sticky.content) ?? "(empty sticky)").slice(0, 40);
    await db.insert(schema.stickyMessages).values({
      guildId: targetGuildId,
      channelId: resolve.required("sticky message", name, "channelId", sticky.channelId),
      content: str(sticky.content) ?? "",
      active: Boolean(sticky.active ?? true),
      repostAfterMessages: Number(sticky.repostAfterMessages ?? 5),
      // Cleared: it names a message in the source guild's channel.
      lastMessageId: null,
    });
    count("stickyMessages");
  }

  return report;
}
