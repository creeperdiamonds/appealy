// shared/lib/ticketCategory.ts
//
// What a ticket actually uses once its category's overrides are applied to the
// ticket type's own settings. One function, so opening a ticket, closing it and
// the "can this person close it" check cannot disagree about who the support
// roles are. Free of env and network so it can be tested.

export interface ConfigSettings {
  name: string;
  categoryId: bigint | null;
  supportRoleIds: string[];
  pingRoleIds: string[];
  welcomeMessage: string | null;
}

export interface CategorySettings {
  label: string;
  discordCategoryId: bigint | null;
  supportRoleIds: string[];
  pingRoleIds: string[];
  welcomeMessage: string | null;
}

export interface EffectiveTicketSettings {
  title: string;
  parentCategoryId: bigint | null;
  supportRoleIds: string[];
  pingRoleIds: string[];
  welcomeMessage: string | null;
}

/** A blank welcome message is "not set", not "send an empty embed". */
function nonBlank(s: string | null | undefined): string | null {
  return s && s.trim().length > 0 ? s : null;
}

export function effectiveTicketSettings(
  config: ConfigSettings,
  category: CategorySettings | null | undefined,
): EffectiveTicketSettings {
  if (!category) {
    return {
      title: config.name,
      parentCategoryId: config.categoryId,
      supportRoleIds: config.supportRoleIds,
      pingRoleIds: config.pingRoleIds,
      welcomeMessage: config.welcomeMessage,
    };
  }
  return {
    title: `${config.name} — ${category.label}`,
    parentCategoryId: category.discordCategoryId ?? config.categoryId,
    supportRoleIds: category.supportRoleIds.length > 0 ? category.supportRoleIds : config.supportRoleIds,
    pingRoleIds: category.pingRoleIds.length > 0 ? category.pingRoleIds : config.pingRoleIds,
    welcomeMessage: nonBlank(category.welcomeMessage) ?? config.welcomeMessage,
  };
}

/** "Billing & Refunds" → "billing-refunds", for a channel name. */
export function slugForChannelName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
