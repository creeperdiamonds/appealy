# Two things called "appeal"

Unrelated systems. Confusing them is the main hazard in this area.

| | Guild ban appeals | Platform bans |
|---|---|---|
| Who bans | A guild bans its own member | We ban a user/guild from the bot |
| Appeals to | That guild's staff | Us |
| Tables | `appeal_configs`, `forms.kind='appeal'` | `platform_bans`, `platform_ban_appeals` |
| Entry point | `guildBanAdd` → DM with a form | Ban screen on the dashboard |
| Reviewed in | The guild's submission queue | `/api/ops`, behind `OPS_USER_IDS` |

Guild staff can never see `platform_bans`. The prefix exists so nobody wires
one to the other.

## Guild ban appeals — restored from `appealy-with-ban-appeals.zip`

Present in that zip, absent from `main`. The branches diverged and the appeal
system didn't come forward. Since it's the feature the product is named after,
treated as a regression.

Ported: `formKindEnum` / `forms.kind` / `appealConfigs` (schema.ts),
`FormKind` / `AppealConfigDTO` (types), `guildBanAdd.ts`, event registration,
`GuildModeration` intent, `introNote` in `dmApplicationService`, auto-unban in
`reviewAccept`, `appealConfig.ts` route + mount, `kind` validation in forms.ts.

### Two bugs fixed during the port

**PATCH could bypass the appeal ⇒ direct_message rule.** Create-time validated
it; update validated only the fields sent. `PATCH {kind:"appeal"}` on an
in_server form, or `PATCH {applicationType:"in_server"}` on an appeal form,
each pass alone and each produce an appeal form no banned user can reach. Now
checked against the merged row.

**A dropped cleanup, restored.** The scaled tree's `startDmApplication` lost
its `if (!sent) delete progress` branch. With DMs closed that left an orphan
`dmApplicationProgress` row, so the applicant hit "You already have an
application in progress" permanently. Both the confirmation and the new
`introNote` path now clean up.

## Before it runs

1. **`GuildModeration` must be enabled in the Discord Developer Portal**, not
   just in code — no `guildBanAdd` otherwise.
2. **Migrations** for `form_kind`, `forms.kind`, `appeal_configs`,
   `platform_bans`, `platform_ban_appeals`. `forms.kind` defaults to
   `application`, so existing rows are unaffected.
3. **No dashboard UI** for `/appeal-config` or for the ops review queue.
   Both are API-only.
