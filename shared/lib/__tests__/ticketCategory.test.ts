import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { effectiveTicketSettings, slugForChannelName } from "../ticketCategory.ts";

const config = {
  name: "Support",
  categoryId: 1n,
  supportRoleIds: ["10"],
  pingRoleIds: ["11"],
  welcomeMessage: "Hello from the config",
};

Deno.test("no category: the config's own settings", () => {
  const s = effectiveTicketSettings(config, null);
  assertEquals(s.title, "Support");
  assertEquals(s.parentCategoryId, 1n);
  assertEquals(s.supportRoleIds, ["10"]);
  assertEquals(s.welcomeMessage, "Hello from the config");
});

Deno.test("a category with no overrides inherits everything but the title", () => {
  const s = effectiveTicketSettings(config, {
    label: "Billing",
    discordCategoryId: null,
    supportRoleIds: [],
    pingRoleIds: [],
    welcomeMessage: "   ",
  });
  assertEquals(s.title, "Support — Billing");
  assertEquals(s.parentCategoryId, 1n);
  assertEquals(s.supportRoleIds, ["10"]);
  assertEquals(s.pingRoleIds, ["11"]);
  assertEquals(s.welcomeMessage, "Hello from the config");
});

Deno.test("a category's own settings win", () => {
  const s = effectiveTicketSettings(config, {
    label: "Billing",
    discordCategoryId: 2n,
    supportRoleIds: ["20"],
    pingRoleIds: ["21"],
    welcomeMessage: "Billing team here",
  });
  assertEquals(s.parentCategoryId, 2n);
  assertEquals(s.supportRoleIds, ["20"]);
  assertEquals(s.pingRoleIds, ["21"]);
  assertEquals(s.welcomeMessage, "Billing team here");
});

Deno.test("slugForChannelName", () => {
  assertEquals(slugForChannelName("Billing & Refunds"), "billing-refunds");
  assertEquals(slugForChannelName("!!!"), "");
});
