// web/src/lib/formTemplates.ts
//
// Ready-made forms for "New form", so the first one is a click and a channel
// rather than a blank page.
//
// Picked from what servers actually build. Of the 75 added in the week of
// 5 Oct 2026, the forms were almost all staff applications, about a fifth of
// the servers applied people to departments (police, fire, transport), the
// next group was Minecraft SMPs, and a few made ban appeals. Most servers that removed Appealy had made no form at all.
//
// Every question is text. A DM form asks each question as a message, so a
// pick-from-a-list question would arrive without its list
// (bot/src/services/dmApplicationService.ts). The in-server ones keep to
// what a Discord pop-up holds: five questions, labels of 45 characters.

export interface TemplateQuestion {
  label: string;
  type: "short_text" | "paragraph";
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
}

export interface FormTemplate {
  id: string;
  /** On the card. */
  title: string;
  /** On the card, under the title. */
  blurb: string;
  name: string;
  description: string;
  kind: "application" | "appeal";
  applicationType: "in_server" | "direct_message";
  questions: TemplateQuestion[];
}

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    id: "staff",
    title: "Staff application",
    blurb: "Moderators, helpers and admins. A pop-up in the server.",
    name: "Staff application",
    description: "Apply to join the staff team.",
    kind: "application",
    applicationType: "in_server",
    questions: [
      { label: "How old are you?", type: "short_text", placeholder: "e.g. 16", maxLength: 3 },
      { label: "What time zone are you in?", type: "short_text", placeholder: "e.g. UTC+2", maxLength: 50 },
      { label: "How many hours a week can you be active?", type: "short_text", maxLength: 50 },
      { label: "Have you been staff anywhere before?", type: "paragraph", placeholder: "Where, and what you did", maxLength: 1000 },
      { label: "Why do you want to join the staff team?", type: "paragraph", maxLength: 1000 },
    ],
  },
  {
    id: "department",
    title: "Police, Fire & EMS",
    blurb: "Department applications for city servers. Asked in DMs.",
    name: "Department application",
    description: "Apply to join one of our departments. The bot will ask you a few questions in DMs.",
    kind: "application",
    applicationType: "direct_message",
    questions: [
      { label: "What is your in-game username?", type: "short_text", maxLength: 50 },
      { label: "How old are you?", type: "short_text", maxLength: 3 },
      { label: "Which department are you applying for?", type: "short_text", placeholder: "Police, Fire, EMS, DOT…", maxLength: 100 },
      { label: "Have you been in a department on another server? Which?", type: "paragraph", maxLength: 1000 },
      { label: "How would you handle a member who won't follow your instructions?", type: "paragraph", maxLength: 1000 },
      { label: "Why should we pick you for this department?", type: "paragraph", maxLength: 1000 },
      { label: "Have you read the server rules and agree to follow them?", type: "short_text", maxLength: 100 },
    ],
  },
  {
    id: "smp",
    title: "Minecraft SMP",
    blurb: "Whitelist or join requests for a survival server.",
    name: "SMP application",
    description: "Apply to join the SMP.",
    kind: "application",
    applicationType: "in_server",
    questions: [
      { label: "Minecraft username", type: "short_text", placeholder: "Java or Bedrock", maxLength: 32 },
      { label: "How old are you?", type: "short_text", maxLength: 3 },
      { label: "How did you find the server?", type: "short_text", maxLength: 100 },
      { label: "What do you like to do in Minecraft?", type: "paragraph", maxLength: 1000 },
      { label: "Anything else we should know?", type: "paragraph", maxLength: 1000, required: false },
    ],
  },
  {
    id: "appeal",
    title: "Ban appeal",
    blurb: "DM'd to members when they're banned, timed out or restricted.",
    name: "Ban appeal",
    description: "You can appeal your punishment here. Staff will review it and get back to you.",
    kind: "appeal",
    applicationType: "direct_message",
    questions: [
      { label: "What were you punished for?", type: "paragraph", maxLength: 1000 },
      { label: "Why should the punishment be lifted?", type: "paragraph", maxLength: 1500 },
      { label: "What will you do differently from now on?", type: "paragraph", maxLength: 1000 },
    ],
  },
];
