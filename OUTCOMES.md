# Multiple accept outcomes

**The problem.** Review is modelled everywhere as accept/deny, which isn't how
staffing decisions work. Someone applies for Trainee and reads as ready for
Moderator. Someone applies for Moderator and is worth taking on as Trainee.
Both currently require accepting into the wrong role and fixing it by hand, or
denying a good applicant and asking them to reapply.

An outcome is *"accept, as X"* — its own roles, message, and log channel. The
reviewer picks one instead of pressing a single Accept.

```
Trainee application from @someone

  ┌─────────────────────────────────────┐
  │ Accept as…                        ▾ │
  └─────────────────────────────────────┘
        Trainee
        limited perms, supervised
        Moderator
        full permissions, can ban members
        Head Moderator
        can manage other staff

  [ Deny ]
```

## The thing that decides whether this is safe

**Outcomes are a privilege escalation surface.** The moment a form can grant
more than one role, "who may pick which outcome" stops being a preference and
becomes a security question.

A trainee-moderator with permission to review trainee applications — normal,
and the reason this feature is wanted — could otherwise accept their friend as
Head Moderator through the trainee form. They never needed Manage Roles. The
application form became the escalation path.

Two guards:

**`minStaffLevel` per outcome**, ranked against `permissionLevelEnum`
(0 manager, 1 admin, 2 owner). Outcomes above the reviewer's level are not
rendered for them at all — filtered, not rejected. A button that's visible and
always fails teaches people the bot is broken, and it leaks your staff
hierarchy to anyone who can see the review message.

**Role hierarchy against the reviewer**, not just the bot. A reviewer may not
grant a role at or above their own highest. Discord enforces this for the bot
and not for the human clicking the button, so an admin-level reviewer sitting
low in the Discord hierarchy could otherwise hand out roles above themselves.

Default `minStaffLevel` is 0, so nothing changes until you raise it. Raise it
on the outcomes that actually grant power.

## Always a menu, never buttons

Even with two outcomes, and even though a button would save a click.

**Deny stops sharing a row with the accepts.** This is the real reason. With
buttons, an irreversible action sits one misclick away from the thing you're
scanning across. Picking from a menu to accept and pressing a distinct button
to deny are different gestures, and hard to confuse when you're forty
applications deep.

**Descriptions are visible at decision time.** A button shows a label. A select
option shows *Moderator* with *full permissions, can ban members* underneath.
For a decision that hands out power, that line is worth more than the click.

**The UI doesn't reshuffle.** With buttons, adding a fifth outcome silently
converts every review message in the guild to a different interaction, and
everyone who had muscle memory starts misclicking.

## Confirmation

On by default for every outcome, and mandatory for any with a raised
`minStaffLevel` — you can't disable the guard where it's load-bearing.

It is **not** an "are you sure?" prompt. That distinction is the whole design:

```
  Accept @someone as Moderator?

  Gains     @Moderator, @Staff
  Loses     @Applicant, @Pending Review
  They get  a DM with your accept message
  Logged in #staff-log

  ⚠️ Won't be applied
  @Admin — sits above my highest role.

  [ Confirm ]  [ Cancel ]
```

A prompt carrying no information gets clicked through within a day. Not a
discipline problem — the reviewer learns the second click is part of the
gesture and stops reading, at which point it costs a click on every review and
prevents nothing.

This one carries things the reviewer doesn't already know. They picked a label
from a menu; here they find out it also strips `@Trusted`, or that the role
list is empty because the outcome was misconfigured, or that a role can't be
applied at all. Those are worth catching, and they keep the step worth reading
at the fortieth application — which is what stops the click becoming reflex.

**Privileged outcomes look different.** Red embed, warning line, destructive
button style. Same reflex problem one layer up: if every confirm looks
identical, the dangerous one doesn't register as dangerous.

**The unmanageable-role warning moves earlier.** Today that's reported *after*
accepting, which is too late — the applicant has already been told they're a
Moderator. Now it's on the confirm, before anything happens.

**Ephemeral and single-use.** Only the reviewer who chose can see or fire it,
bound to their user id (custom_ids are guessable). Consumed on read, so a
double-click can't apply twice. Two-minute expiry, in memory — a dropped
confirm on restart costs one extra click and nothing else, which doesn't
justify a Redis round trip on every review.

Because it's ephemeral, another reviewer can decide the same submission while a
confirm sits open, so the handler re-checks submission status at confirm time
rather than trusting state from when the menu opened.

## Audit

`submissions.outcomeLabel` is a snapshot, duplicated rather than joined.
Outcomes get renamed and deleted; *"accepted as Moderator on 3 June"* has to
stay true afterwards. An audit trail that rewrites itself when someone edits a
form isn't an audit trail. The FK nulls on delete; the text survives.

## Backward compatible

A form with zero outcome rows behaves exactly as today — one Accept button
using `forms.grantRoleIds`. Nothing migrates. Nothing changes for existing
guilds until someone adds an outcome.

## Also worth doing later

**Denial outcomes.** The same argument applies in reverse: *"denied, reapply in
30 days"* and *"denied, don't reapply"* are different decisions currently
flattened into one. Cheaper to add once outcomes exist.

**Appeal outcomes.** For `kind = "appeal"` forms this maps onto *unban*,
*unban with a warning*, *reduce to a timeout* — which is much closer to how
moderation decisions actually get made than accept/deny.

## Built

Schema, migration (`0001_far_microchip.sql`), both permission guards, the menu,
the confirm step, and the full `reviewAccept.ts` path — menu → select →
confirm → apply. Routed in `interactionCreate.ts` under `review:outcome`,
`review:confirm`, `review:cancel`.

## Still missing

**Outcome CRUD.** No API routes and no form-editor UI, so outcomes can only be
created by inserting rows directly. That's the last piece before this is usable
by anyone but you.

**Denial outcomes.** `handleReviewDeny` is untouched — *"denied, reapply in 30
days"* vs *"denied, don't reapply"* are still one decision. Cheaper to add now
that the accept side exists.
