import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AppealyBot, AppealyInteraction } from "../../core/client.ts";
import { defer, finish } from "../interactionResponse.ts";

interface Call { name: string; args: unknown[] }

function fakeBot(): { bot: AppealyBot; calls: Call[] } {
  const calls: Call[] = [];
  const bot = {
    helpers: {
      sendInteractionResponse: (...args: unknown[]) => {
        calls.push({ name: "send", args });
        return Promise.resolve();
      },
      editOriginalInteractionResponse: (...args: unknown[]) => {
        calls.push({ name: "edit", args });
        return Promise.resolve();
      },
    },
  } as unknown as AppealyBot;
  return { bot, calls };
}

const interaction = { id: 123n, token: "tok" } as unknown as AppealyInteraction;

Deno.test("defer sends type 5 with the ephemeral flag", async () => {
  const { bot, calls } = fakeBot();
  await defer(bot, interaction, { ephemeral: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "send");
  assertEquals(calls[0].args[0], 123n);
  assertEquals(calls[0].args[1], "tok");
  assertEquals(calls[0].args[2], { type: 5, data: { flags: 64 } });
});

Deno.test("defer without ephemeral carries no flags", async () => {
  const { bot, calls } = fakeBot();
  await defer(bot, interaction);
  assertEquals(calls[0].args[2], { type: 5, data: {} });
});

Deno.test("finish edits the original response with a string", async () => {
  const { bot, calls } = fakeBot();
  await finish(bot, interaction, "done");
  assertEquals(calls[0].name, "edit");
  assertEquals(calls[0].args[0], "tok");
  assertEquals(calls[0].args[1], { content: "done" });
});

Deno.test("finish passes a payload through untouched and adds no flags", async () => {
  const { bot, calls } = fakeBot();
  await finish(bot, interaction, { content: "hi", components: [] });
  assertEquals(calls[0].args[1], { content: "hi", components: [] });
});
