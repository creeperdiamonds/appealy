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

---

# The rules, and why they're shaped this way

Appealy exists because a bot said *"this decision is final and cannot be
appealed."* The platform ban system in this repo could easily have become the
same thing — a queue-protection pattern copied from anywhere else — so it's
shaped deliberately against that.

**Automated bans get more attempts than reviewed ones.** Five versus three. A
ban nobody looked at is the most likely to be wrong, and the person on the
other end did nothing to deserve a shorter rope than someone a human actually
considered.

**Running out of attempts pauses appeals. It never ends them.** After
`reopenAfterDays` the count resets. The message says how many days, because
"come back in 34 days" is something a person can plan around and "you're out
of appeals" is not.

**Denials require a real sentence.** At least twenty characters, enforced by
the API. "denied" is technically a note and tells the appellant nothing. There
is a second reason for this: if a ban can't be explained in twenty characters,
that's worth noticing *before* the denial goes out.

**The word "final" appears nowhere in any user-facing string.** Worth grepping
for before you merge anything here.

**Ban notices always state the reason and always link the appeal.** In
`banGate.ts`, unqualified.

The limits are still real — one person submitting fifty appeals buries every
genuine one behind them, and the people that harms are the other appellants.
Protecting the queue is protecting them. It just doesn't require telling anyone
their case is closed forever.

## The structural argument

The strongest thing about Appealy isn't any of this. It's that a self-hosted
bot means a false ban from *you* is survivable in a way a false ban from a
hosted bot isn't — they hold the token, you don't. Worth saying in the README
rather than leaving implied.
