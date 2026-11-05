# Security

## Reporting a problem

If you find a way to get at data or powers you shouldn't have in Appealy (the
bot, the dashboard at appealy.app, or the API), email
**contact@creeperdiamonds.xyz** with "Security" in the subject. Please don't
open a public issue for it, or post it anywhere, until it's fixed.

Helpful to include:

- what you can do that you shouldn't be able to, and on which part of Appealy
- the steps to do it again
- what you think someone could do with it

You'll get a reply within 3 days. Once it's fixed, you'll be thanked by name in
the release notes, unless you'd rather not be. There is no paid bug bounty.

## Testing in good faith

You won't be reported or banned for looking for problems, as long as you:

- test on a server you own, with accounts you own
- stop as soon as you can see someone else's data, and don't keep, copy or share it
- don't try to slow down or take Appealy offline
- don't use what you find for anything except reporting it

## If Appealy is breached

If someone gets at data they shouldn't have, Appealy will say so publicly, as
soon as it's confirmed: on appealy.app, on the status page and in the support
server. The notice says what was reached, whose data it was and what to do,
and it won't be hidden from search engines. People whose data was affected
will be told directly where Appealy has a way to reach them.

## What Appealy keeps

Appealy doesn't store IP addresses, browser details or email addresses, so
none of them can leak. What it does keep, and for how long, is listed in the
[privacy policy](https://appealy.app/privacy). Deletion requests are carried
out with `scripts/delete-user-data.ts`, which covers every table that holds a
Discord user ID.
