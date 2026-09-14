# Ban appeals

Appealy exists because a bot once said *“this decision is final and cannot be appealed.”* Everything on this page is shaped against becoming that.

## Three things are called an appeal

They are separate systems, and confusing them is the main hazard in this area. The first is the product: your server, moderating its own members. The other two are us moderating our own platform, and they split by *what* was banned — an account or a whole server.

|  | 1\. Server ban appeal | 2\. Platform ban, account | 3\. Platform ban, server |
| --- | --- | --- | --- |
| Who bans | A server bans its own member | We ban someone from Appealy itself | We ban someone from Appealy itself |
| What is banned | One member, in one server | One Discord account | One Discord server |
| What it stops | Being in that server | That account using Appealy anywhere | Appealy working in that server, for everyone in it |
| Who may appeal | The banned member | The banned account, and nobody else | Anyone with Manage Server on it |
| Appeals to | That server’s staff | Us | Us |
| Entry point | The ban itself — a DM with a form | The ban screen, wherever they next try to use the bot | The ban screen, wherever they next try to use the bot |
| Reviewed in | The server’s own submission queue | The operator queue, behind an explicit allow-list | The operator queue, behind an explicit allow-list |

Server staff can never see platform bans, and there is no path from one to the other. The separation is enforced in the schema rather than by convention, so nobody can wire them together by accident.

### Why 2 and 3 are one system and not two

They are the same table, distinguished by a single column saying whether the subject is an account or a server. That is deliberate: the rules below — the attempt counts, the reopen window, the requirement that a denial be written out — are the part worth getting right, and they should not quietly differ depending on which kind of thing was banned.

What genuinely differs is **who is allowed to file**, and it is the one place the two are checked differently:

-   **An account ban** can only be appealed by that account. Nobody appeals on someone else’s behalf.
-   **A server ban** is appealed by anyone who owns it or holds Manage Server — verified against Discord’s live answer at the moment of filing, not against a stored role and not against our own record of who is in which server, either of which can be out of date by the time it matters.

The distinction shows up in what the banned party is told, too. An account ban says *your account can’t use Appealy* and points you at the appeal. A server ban says *this server can’t use Appealy* and says that anyone with Manage Server can appeal — because the person who happened to run the command is very often not the person who can do anything about it.

**The next section is about the first column** — the appeals your own server runs, which is the feature you are here for. The section after it covers the other two, and it is published because the rules we hold ourselves to are the ones worth being able to check.

## How a server ban appeal works

1.  Someone is banned. Appealy sees the gateway’s ban event — which needs the **Server Moderation** intent enabled in the Developer Portal, or nothing below ever happens. See [Getting started](README.md).
2.  They are DM’d, with the reason and a link to the appeal, and walked through the appeal form one question at a time.
3.  The appeal lands in the same review queue as everything else, so staff review it the way they review an application.
4.  An accept lifts the ban. That is the whole point of the accept — it is not a note that someone then has to action by hand.

An appeal form is a normal form with its kind set to *appeal*, and it must be delivered by direct message: a banned member cannot see a channel to press a button in. The API enforces that pairing on create *and* on edit, against the merged row rather than only the fields sent, because each half passes on its own and the combination produces an appeal form no banned user can reach.

> **Two states the dashboard warns about**, because neither produces an error: an appeal system that is enabled with no form selected, and a form that is set with the ban-time DM switched off. Both mean there is no entry point at all, and both are otherwise discovered months later when nobody has appealed.

## The rules we hold ourselves to

This section is about the second and third columns — the bans we issue, against an account or against a server. Your own server sets its own policy and we do not constrain it; what follows is what the code enforces on *us*, and it applies identically to both kinds. It is published because a promise nobody can check is not a promise.

The platform ban system could easily have become a queue-protection pattern copied from anywhere else. These are the decisions that stop it.

### Automated bans get more attempts than reviewed ones

Five versus three. A ban nobody looked at is the most likely to be wrong, and the person on the other end did nothing to deserve a shorter rope than someone a human actually considered.

### Running out of attempts pauses appeals. It never ends them

Attempts are spaced 30 days apart, and once they are exhausted the counter resets 180 days later with a fresh allowance. The message says the date. “You may appeal again on a day you can count towards” is something a person can plan around; “you are out of appeals” is not.

The reopen window is deliberately finite rather than large. Six months is a long time to wait, and it is a different thing from never, which is the distinction the whole system turns on.

The limits are real, and they are not there to be dismissive: one person filing fifty appeals buries every genuine one behind them, and the people that harms are the other appellants. Protecting the queue is protecting them. It just does not require telling anyone their case is closed forever.

### An apology is a second lane, and it is scarce on purpose

Two per person, for life, never reset — deliberately unlike every other limit here. That looks like a contradiction of the rule above, so it is worth being precise: running out of apologies takes nothing away. The appeal path stays open on its own schedule, and it is the path that can actually overturn a ban. An apology is an extra lane offered on top, and it only works *because* it is scarce.

Two rather than one because the first is often spent early and clumsily, by someone who has just been banned and is not thinking well. Two rather than three because by the third, “I am sorry” is a form response.

### Denials require a real sentence

At least twenty characters, enforced by the API rather than requested in a placeholder. “Denied” is technically a note and tells the appellant nothing. There is a second reason for the rule: if a ban cannot be explained in twenty characters, that is worth noticing *before* the denial goes out.

### The word “final” appears in no user-facing string

Anywhere. It is a thing to grep for before merging anything in this area.

### Ban notices always state the reason and always link the appeal

Unqualified, with no configuration flag to turn either half off.

## The structural argument

The strongest thing here is not any single rule. It is that a self-hosted bot means a false ban from *us* is survivable in a way a false ban from a hosted bot is not — they hold the token, you do not. Every rule above is a promise, and a promise is only worth what happens when it is broken. Being able to take the whole thing and run it yourself is what makes the promise cost something.

---

Next: [Review outcomes](outcomes.md), which is where *unban*, *unban with a warning* and *reduce to a timeout* will live once denial outcomes exist — or [Self-hosting](../self-hosting/README.md) for the argument above, in commands.
