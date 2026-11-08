// bot/src/services/modalAnswers.ts
//
// Reading what someone typed or picked in a submitted popup.
//
// A popup's answers arrive in one of two shapes. Popups built before Labels
// put each text box in an action row (`{type: 1, components: [...]}`).
// Popups built now put each question in a Label (`{type: 18, component}`),
// which can hold a dropdown as well as a text box, and may start with a Text
// Display (`{type: 10}`) that has no answer. Both are read here, so a popup
// opened before a deploy still submits after it.
//
// Free of env and network so it can be tested.

export interface SubmittedComponent {
  type?: number;
  customId?: string;
  value?: string;
  values?: string[];
  components?: (SubmittedComponent | undefined)[];
  component?: SubmittedComponent;
}

/**
 * The IDs of files uploaded through one File Upload field. Each ID names an
 * attachment in the interaction's resolved data.
 */
export function readModalFileIds(components: (SubmittedComponent | undefined)[] | undefined, customId: string): string[] {
  for (const top of components ?? []) {
    const c = top?.component;
    if (c?.customId === customId && Array.isArray(c.values)) return c.values.map(String);
  }
  return [];
}

/** Question id → answer. A dropdown's answer is the value of the option picked. */
export function readModalAnswers(components: (SubmittedComponent | undefined)[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (c: SubmittedComponent | undefined) => {
    if (!c?.customId) return;
    if (typeof c.value === "string") out[c.customId] = c.value;
    else if (Array.isArray(c.values)) out[c.customId] = c.values[0] ?? "";
  };
  for (const top of components ?? []) {
    if (!top) continue;
    take(top.component);
    for (const c of top.components ?? []) take(c);
  }
  return out;
}

interface RawComponent {
  type: number;
  values?: string[];
  component?: RawComponent;
  [key: string]: unknown;
}

/**
 * For bot.transformers.customizers.component (core/client.ts).
 *
 * Discordeno 20 predates Labels and Text Displays: its component transform
 * has no case for them and returns undefined, and its select transform leaves
 * out `values`, which is the only part of a submitted dropdown that matters.
 * This fills those in and leaves every other component as Discordeno made it.
 */
export function labelComponentCustomizer(
  bot: { transformers: { component: (bot: never, payload: never) => unknown } },
  payload: RawComponent,
  component: unknown,
): unknown {
  if (payload.type === 18) {
    return {
      type: 18,
      component: payload.component ? bot.transformers.component(bot as never, payload.component as never) : undefined,
    };
  }
  if (payload.type === 10) return { type: 10 };
  // Anything else Discordeno doesn't know (a File Upload, 19): its id and
  // what was picked or uploaded are all that's needed.
  if (component === undefined && typeof payload.custom_id === "string") {
    return {
      type: payload.type,
      customId: payload.custom_id,
      ...(Array.isArray(payload.values) ? { values: payload.values } : {}),
      ...(typeof payload.value === "string" ? { value: payload.value } : {}),
    };
  }
  if (payload.type === 3 && Array.isArray(payload.values) && component && typeof component === "object") {
    return { ...component, values: payload.values };
  }
  return component;
}
