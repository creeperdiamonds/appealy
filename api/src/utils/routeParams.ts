// api/src/utils/routeParams.ts
//
// Typed access to route parameters that come from a parent mount.
//
// Express infers req.params from each route's own PATH STRING, so
// `router.get("/", handler)` types req.params as {} — even when the router was
// built with mergeParams: true and is mounted under /api/guilds/:guildId,
// which supplies guildId at runtime. Every handler reading req.params.guildId
// therefore failed to compile while working correctly when run: 38 errors for
// code that was not wrong.
//
// The typings cannot see the mount path, so no arrangement of generics can
// derive this. What is left is to state it once, here, rather than as a cast
// repeated at every call site where it would drift and be re-argued.
//
// The caveat, stated rather than hidden: this asserts the union of parameter
// names used anywhere under the guild mount, so a handler on a path that does
// not declare :formId is still told formId is a string, and would get
// undefined at runtime. Check the route's own path before reading a parameter
// it does not declare. mergeParams: true on the router remains load-bearing —
// it is what makes the parent's parameters actually present.

import type { Request } from "express";

/** Route parameters available to handlers mounted under /api/guilds/:guildId. */
export interface GuildRouteParams {
  guildId: string;
  formId: string;
  panelId: string;
  pollId: string;
  submissionId: string;
  outcomeId: string;
  giveawayId: string;
  configId: string;
  menuId: string;
  stickyId: string;
  responseId: string;
  categoryId: string;
  delegationId: string;
  banId: string;
  jobId: string;
  type: string;
  id: string;
}

export function routeParams(req: Request): GuildRouteParams {
  return req.params as unknown as GuildRouteParams;
}
