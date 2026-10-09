// bot/src/services/applicationStatus.ts
//
// One line of /application status (commands/application.ts). Apart from the
// command so it can be tested without a database.

const ICON: Record<string, string> = { pending: "🕓", accepted: "✅", denied: "❌", withdrawn: "↩️" };

/** "🕓 **Moderator** · Waiting for review · applied <t:…:R>". */
export function statusLine(row: {
  formName: string;
  status: string;
  outcomeLabel: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}): string {
  const applied = `applied <t:${Math.floor(row.createdAt.getTime() / 1000)}:R>`;
  const decided = row.reviewedAt ? `, decided <t:${Math.floor(row.reviewedAt.getTime() / 1000)}:R>` : "";
  const status =
    row.status === "pending" ? "Waiting for review"
    : row.status === "accepted" ? (row.outcomeLabel ? `Accepted as ${row.outcomeLabel}` : "Accepted")
    : row.status === "denied" ? "Denied"
    : row.status === "withdrawn" ? "Withdrawn"
    : row.status;
  return `${ICON[row.status] ?? "•"} **${row.formName}** · ${status} · ${applied}${row.status === "pending" ? "" : decided}`;
}
