// api/src/utils/discordIds.ts
//
// Zod fields for Discord IDs arriving from the dashboard. A lone ID that isn't one
// used to reach BigInt() in the route and answer 500. A list of them was stored as
// it came, and the bot found out later: a ping role saved as a role's name stopped
// an application's review post.
//
// shared/lib/__tests__/apiIdFields.test.ts fails on an ID field that doesn't use
// these or its own pattern.

import { z } from "zod";
import { isSnowflake, onlySnowflakes } from "../../../shared/lib/snowflake.ts";

const NOT_AN_ID = "That isn't a Discord ID.";

export const discordId = z.string().refine((text) => isSnowflake(text), NOT_AN_ID);

/** For a setting that can be left empty, where the route reads "" as none. */
export const discordIdOrBlank = z.string().refine((text) => text === "" || isSnowflake(text), NOT_AN_ID);

/**
 * Drops text that isn't an ID rather than refusing the save. Forms saved before
 * this check can hold some, the editor sends them back untouched, and refusing
 * would lock someone out of a form over a setting that never worked.
 */
export const discordIdList = z.array(z.string()).transform((texts) => onlySnowflakes(texts));
