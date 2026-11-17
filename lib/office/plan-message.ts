import type { SlackBody } from "../slack/api.ts";

export const PLAN_ACTION = {
  away: "desk_plan_away",
  coming: "desk_plan_coming",
  change: "desk_plan_change",
  swap: "desk_plan_swap",
  prepare: "desk_plan_prepare",
  skip: "desk_plan_skip",
  swapAccept: "desk_plan_swap_accept",
  swapDecline: "desk_plan_swap_decline",
} as const;

export const PLAN_CALLBACK = { change: "desk_plan_change_modal", swap: "desk_plan_swap_modal" } as const;

export const PLAN_ACTION_IDS: ReadonlySet<string> = new Set(Object.values(PLAN_ACTION));
export const PLAN_CALLBACK_IDS: ReadonlySet<string> = new Set(Object.values(PLAN_CALLBACK));

export const SLACK_LIMITS = {
  blocks: 50,
  sectionText: 3000,
  altText: 2000,
  buttonText: 75,
  actionValue: 2000,
  options: 100,
  optionText: 75,
};

export type PlanSeat = { label: string; name: string };

export type PlanMessageInput = {
  date: string;
  title: string;
  intro: string;
  imageUrl: string;
  seats: PlanSeat[];
  overflow: string[];
  notes: string[];
  version: number;
};

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const button = (actionId: string, text: string, value: string, style?: "primary" | "danger") => ({
  type: "button",
  action_id: actionId,
  text: { type: "plain_text", text: clip(text, SLACK_LIMITS.buttonText) },
  value: clip(value, SLACK_LIMITS.actionValue),
  ...(style ? { style } : {}),
});

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: clip(text, SLACK_LIMITS.sectionText) } });

export function seatsLine(seats: PlanSeat[]): string {
  return seats.map((seat) => `*${seat.label}* ${seat.name}`).join(" · ");
}

export function altText(date: string, seats: PlanSeat[]): string {
  const list = seats.map((seat) => `${seat.label}: ${seat.name}`).join(", ");
  return clip(`Mapa biurek na ${date}${list ? ` — ${list}` : ""}`, SLACK_LIMITS.altText);
}

export function planMessage(input: PlanMessageInput): { text: string; blocks: SlackBody[] } {
  const blocks: SlackBody[] = [
    section(input.intro),
    {
      type: "image",
      image_url: input.imageUrl,
      alt_text: altText(input.date, input.seats),
      title: { type: "plain_text", text: input.title },
    },
    ...(input.seats.length > 0 ? [section(seatsLine(input.seats))] : []),
    ...(input.overflow.length > 0 ? [section(`:warning: Brakuje biurek dla: ${input.overflow.join(", ")}`)] : []),
    ...input.notes
      .slice(0, 5)
      .map((note) => ({ type: "context", elements: [{ type: "mrkdwn", text: clip(note, SLACK_LIMITS.sectionText) }] })),
    {
      type: "actions",
      block_id: `desk_plan:${input.date}`,
      elements: [
        button(PLAN_ACTION.away, "Nie będę", input.date, "danger"),
        button(PLAN_ACTION.coming, "Jednak będę", input.date, "primary"),
        button(PLAN_ACTION.change, "Zmień biurko", input.date),
        button(PLAN_ACTION.swap, "Zamień się z…", input.date),
      ],
    },
  ];
  return { text: `${input.title}: ${input.intro}`, blocks };
}

export function headsUpMessage(date: string, text: string): { text: string; blocks: SlackBody[] } {
  return {
    text,
    blocks: [
      section(text),
      {
        type: "actions",
        block_id: `desk_plan_heads_up:${date}`,
        elements: [button(PLAN_ACTION.prepare, "Przygotuj", date, "primary"), button(PLAN_ACTION.skip, "Nie trzeba", date)],
      },
    ],
  };
}

export function closedMessage(text: string, note: string): { text: string; blocks: SlackBody[] } {
  return { text, blocks: [section(text), { type: "context", elements: [{ type: "mrkdwn", text: clip(note, SLACK_LIMITS.sectionText) }] }] };
}

export type SwapRequest = { date: string; from: string; to: string; fromDesk: string; toDesk: string };

export function encodeSwap(request: SwapRequest): string {
  return JSON.stringify(request);
}

export function decodeSwap(value: unknown): SwapRequest | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<SwapRequest>;
    const fields = [parsed.date, parsed.from, parsed.to, parsed.fromDesk, parsed.toDesk];
    return fields.every((field) => typeof field === "string" && field !== "") ? (parsed as SwapRequest) : null;
  } catch {
    return null;
  }
}

export function swapRequestMessage(request: SwapRequest, text: string): { text: string; blocks: SlackBody[] } {
  const value = encodeSwap(request);
  return {
    text,
    blocks: [
      section(text),
      {
        type: "actions",
        elements: [button(PLAN_ACTION.swapAccept, "Zamieniam się", value, "primary"), button(PLAN_ACTION.swapDecline, "Nie", value)],
      },
    ],
  };
}

export type ModalOption = { label: string; value: string };

export function selectModal(input: {
  callbackId: string;
  title: string;
  label: string;
  submit: string;
  options: ModalOption[];
  metadata: Record<string, string | null>;
}): SlackBody {
  return {
    type: "modal",
    callback_id: input.callbackId,
    private_metadata: JSON.stringify(input.metadata),
    title: { type: "plain_text", text: clip(input.title, 24) },
    submit: { type: "plain_text", text: clip(input.submit, 24) },
    close: { type: "plain_text", text: "Anuluj" },
    blocks: [
      {
        type: "input",
        block_id: "choice",
        label: { type: "plain_text", text: input.label },
        element: {
          type: "static_select",
          action_id: "value",
          options: input.options.slice(0, SLACK_LIMITS.options).map((option) => ({
            text: { type: "plain_text", text: clip(option.label, SLACK_LIMITS.optionText) },
            value: option.value,
          })),
        },
      },
    ],
  };
}

export const selectedValue = (payload: Record<string, any>): string | null => {
  const value = payload.view?.state?.values?.choice?.value?.selected_option?.value;
  return typeof value === "string" && value !== "" ? value : null;
};
