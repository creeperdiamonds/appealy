# Review outcomes

Review is modelled almost everywhere as accept or deny, which is not how staffing decisions work. An outcome is *“accept, as X”* — its own roles, its own message, its own log channel.

## The problem

Someone applies for Trainee and reads as ready for Moderator. Someone applies for Moderator and is worth taking on as Trainee. With a single Accept button both cases require accepting into the wrong role and fixing it by hand, or denying a good applicant and asking them to reapply.

So the reviewer picks from a menu instead:

```
Trainee application from @someone

  +-----------------------------------+
  | Accept as...                    v |
  +-----------------------------------+
        Trainee
        limited perms, supervised
        Moderator
        full permissions, can ban members
        Head Moderator
        can manage other staff

  [ Deny ]
```

## Outcomes are a privilege-escalation surface

This is the part that decides whether the feature is safe at all. The moment a form can grant more than one role, “who may pick which outcome” stops being a preference and becomes a security question.

A trainee moderator with permission to review trainee applications — normal, and the reason this feature is wanted in the first place — could otherwise accept their friend as Head Moderator through the trainee form. They never needed Manage Roles. The application form became the escalation path.

Two guards:

### A minimum staff level, per outcome

Ranked against the same permission levels the rest of the dashboard uses. Outcomes above the reviewer’s level are **not rendered for them at all** — filtered, not rejected. A button that is visible and always fails teaches people the bot is broken, and it leaks your staff hierarchy to anyone who can see the review message.

The default is the lowest level, so nothing changes until you raise it. Raise it on the outcomes that actually grant power.

### Role hierarchy, checked against the reviewer

Not just against the bot. A reviewer may not grant a role at or above their own highest. Discord enforces hierarchy for the bot and not for the human pressing the button, so an admin-level reviewer sitting low in the Discord hierarchy could otherwise hand out roles above themselves.

## Always a menu, never buttons

Even with two outcomes, and even though a button would save a click.

-   **Deny stops sharing a row with the accepts.** This is the real reason. With buttons, an irreversible action sits one misclick away from the thing you are scanning across. Picking from a menu to accept and pressing a distinct button to deny are different gestures, and hard to confuse when you are forty applications deep.
-   **Descriptions are visible at decision time.** A button shows a label. A menu option shows *Moderator* with *full permissions, can ban members* underneath. For a decision that hands out power, that line is worth more than the click it costs.
-   **The interface does not reshuffle.** With buttons, adding a fifth outcome silently converts every review message in the server to a different interaction, and everyone who had muscle memory starts misclicking.

## The confirmation is not “are you sure?”

That distinction is the whole design. It is on by default for every outcome and mandatory for any with a raised staff level — you cannot disable the guard where it is load-bearing.

```
  Accept @someone as Moderator?

  Gains     @Moderator, @Staff
  Loses     @Applicant, @Pending Review
  They get  a DM with your accept message
  Logged in #staff-log

  (!) Won't be applied
      @Admin - sits above my highest role.

  [ Confirm ]  [ Cancel ]
```

A prompt carrying no information gets clicked through within a day. That is not a discipline problem: the reviewer learns the second click is part of the gesture and stops reading, at which point it costs a click on every review and prevents nothing.

This one carries things the reviewer does not already know. They picked a label from a menu; here they find out it also strips *@Trusted*, or that the role list is empty because the outcome was misconfigured, or that a role cannot be applied at all. Those are worth catching, and they are what keeps the step worth reading at the fortieth application — which is what stops the click becoming reflex.

Three details that follow from that:

-   **Privileged outcomes look different.** Red embed, warning line, destructive button. Same reflex problem one layer up: if every confirm looks identical, the dangerous one does not register as dangerous.
-   **The unmanageable-role warning moved earlier.** It used to be reported after accepting, which is too late — the applicant has already been told they are a Moderator. It is now on the confirm, before anything happens.
-   **Ephemeral and single-use.** Only the reviewer who chose can see or fire it, bound to their user id. It is consumed on read, so a double-click cannot apply twice, and it expires after two minutes.

Because it is ephemeral, another reviewer can decide the same submission while a confirm sits open. The handler re-checks the submission’s status at confirm time rather than trusting what was true when the menu opened.

## The audit trail does not rewrite itself

The outcome label is stored on the submission as a snapshot, duplicated rather than looked up. Outcomes get renamed and deleted; *“accepted as Moderator on 3 June”* has to stay true afterwards. An audit trail that changes when someone edits a form is not an audit trail. Delete the outcome and the text survives.

## Nothing changes until you add one

A form with no outcomes behaves exactly as it always did: one Accept button using the form’s own role grants. Nothing migrates, and nothing changes for existing servers until someone adds an outcome. The editor is reachable from the Outcomes action on each row of the Forms page.

> **Denial outcomes do not exist yet.** *“Denied, reapply in 30 days”* and *“denied, do not reapply”* are different decisions and are still flattened into one. The same argument applies in reverse, and it is cheaper to add now that the accept side exists — but it is not built, so this page does not describe it as though it were.

---

The same shape maps onto appeals — *unban*, *unban with a warning*, *reduce to a timeout* — which is much closer to how moderation decisions actually get made than accept or deny. See [Ban appeals](ban-appeals.md).
