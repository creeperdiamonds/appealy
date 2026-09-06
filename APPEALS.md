# Three things called "appeal"

Confusing them is the main hazard in this area.

| | 1. Guild ban appeal | 2. Platform ban, account | 3. Platform ban, guild |
|---|---|---|---|
| Who bans | A guild bans its own member | We ban a user from the bot | We ban a guild from the bot |
| Subject | A member of one guild | `subject='user'` | `subject='guild'` |
| What it stops | Being in that guild | That account, everywhere | The bot, for everyone in that guild |
| Who may file | The banned member | That account only | Owner, or `MANAGE_GUILD` |
| Appeals to | That guild's staff | Us | Us |
| Tables | `appeal_configs`, `forms.kind='appeal'` | `platform_bans`, `platform_ban_appeals` | same |
| Entry point | `guildBanAdd` → DM with a form | `banGate.ts`, on the next interaction | same |
| Reviewed in | The guild's submission queue | `/api/ops`, behind `OPS_USER_IDS` | same |

Guild staff can never see `platform_bans`. The prefix exists so nobody wires
one to the other.

## Two and three are one implementation, split on one column

`banSubjectEnum` is `["user", "guild"]` and that is the whole difference in
storage. Keeping them in one table is deliberate — `APPEAL_RULES` is the part
worth getting right, and attempt counts, the reopen window and the
twenty-character denial note should not quietly diverge by subject.

**Authorization is the one place they branch**, in `platformAppeals.ts`:

- `subject='user'` — `ban.subjectId !== appellantId` is a 403. Nobody appeals
  for someone else.
- `subject='guild'` — checked against the **live OAuth guilds payload**, not a
  stored role and not the `guilds` table, which goes stale the moment the bot
  is removed. Owner, or the `MANAGE_GUILD` bit.

They are also two different messages, in `banGate.ts`:

```
user   Your account can't use Appealy.   -> "You can appeal at …"
guild  This server can't use Appealy.    -> "Anyone with Manage Server can appeal at …"
```

That second line matters more than it looks. The member who happened to run the
command is very often not the person who can do anything about it, and telling
them "you can appeal" sends them to a form that will 403.

**Why the split is worth naming at all**, given it is one table: a document
organised around who reviews sees two systems, which is right for reading the
schema. Someone who has just been told they cannot use the bot is living in one
of three situations, and which one decides what they are told, who has to act,
and what has actually been taken away. `site/docs/ban-appeals.html` is written
on the second split for that reason.

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
