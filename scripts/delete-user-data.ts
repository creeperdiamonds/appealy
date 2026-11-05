// scripts/delete-user-data.ts
//
// Carries out a deletion request for one Discord user, using the rules in
// shared/services/userDataDeletion.ts.
//
//   Show what would happen (only reads; safe on a read-only connection):
//     deno run -c bot/deno.json --allow-env --allow-net --allow-read scripts/delete-user-data.ts <user id>
//
//   Do it (one transaction, all or nothing):
//     deno run -c bot/deno.json --allow-env --allow-net --allow-read scripts/delete-user-data.ts <user id> --apply
//
// DATABASE_URL must be set, through the Cloud SQL proxy for production. Run it
// without --apply first and read the list: an open ticket or a pending
// application in it is something the server's staff are still working on.
//
// Afterwards, reply to the person saying it's done, and what was kept and why
// (the "keep" lines).

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { deleteUserData, planUserDeletion, type DeletionLine } from "../shared/services/userDataDeletion.ts";

const [idArg, ...flags] = Deno.args;
const apply = flags.includes("--apply");

if (!idArg || !/^\d{17,20}$/.test(idArg)) {
  console.error("Usage: delete-user-data.ts <Discord user ID> [--apply]");
  Deno.exit(2);
}
const url = Deno.env.get("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL isn't set.");
  Deno.exit(2);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

function print(lines: DeletionLine[], done: boolean) {
  const verb = { delete: done ? "deleted" : "delete", anonymize: done ? "anonymized" : "anonymize", unlist: done ? "unlisted" : "unlist", keep: "kept" };
  for (const l of lines.filter((l) => l.rows > 0)) {
    console.log(`${String(l.rows).padStart(6)}  ${verb[l.action].padEnd(10)} ${l.table}.${l.column}`);
    if (l.action === "keep") console.log(`        ${l.why}`);
  }
  if (!lines.some((l) => l.rows > 0)) console.log("Nothing stored for this user.");
}

try {
  const userId = BigInt(idArg);
  if (apply) {
    print(await deleteUserData(db, userId), true);
    console.log("\nDone. Deleted rows don't come back; Cloud SQL backups age out within 7 days.");
  } else {
    print(await planUserDeletion(db, userId), false);
    console.log("\nNothing was changed. Run again with --apply to do it.");
  }
} finally {
  await client.end();
}
