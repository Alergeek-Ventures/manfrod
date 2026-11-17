import { describe, expect, it } from "vitest";
import {
  altText,
  decodeSwap,
  headsUpMessage,
  PLAN_ACTION,
  PLAN_ACTION_IDS,
  planMessage,
  selectModal,
  SLACK_LIMITS,
  swapRequestMessage,
} from "../../lib/office/plan-message.ts";
import {
  crowding,
  dayPhrase,
  fallbackIntro,
  headsUpDates,
  headsUpText,
  nextWorkday,
  peopleCount,
  planCronAction,
  workdaysAfter,
} from "../../lib/office/plan-rules.ts";

const TUESDAY = "2026-11-17";
const base = { visitNotes: [], demand: 2, supply: 5, expectedInOffice: 3, threshold: 6 };

describe("crowding", () => {
  it("stays quiet with a few people and enough free desks", () => {
    expect(crowding(base)).toEqual({ crowded: false, reasons: [] });
  });

  it("is crowded when a visit is recorded", () => {
    expect(crowding({ ...base, visitNotes: ["zespół z Wrocławia"] })).toEqual({
      crowded: true,
      reasons: ["przyjeżdża: zespół z Wrocławia"],
    });
  });

  it("is crowded when owners' desks are needed", () => {
    expect(crowding({ ...base, demand: 6, supply: 5 }).reasons).toEqual([
      "6 osób bez własnego biurka, a wolnych biurek bez właściciela jest 5",
    ]);
    expect(crowding({ ...base, demand: 5, supply: 5 }).crowded).toBe(false);
  });

  it("is crowded at the headcount threshold", () => {
    expect(crowding({ ...base, expectedInOffice: 6 }).reasons).toEqual(["~6 osób w biurze (próg: 6)"]);
    expect(crowding({ ...base, expectedInOffice: 5 }).crowded).toBe(false);
  });

  it("declines Polish plurals", () => {
    expect([1, 2, 4, 5, 12, 22, 25].map(peopleCount)).toEqual([
      "1 osoba",
      "2 osoby",
      "4 osoby",
      "5 osób",
      "12 osób",
      "22 osoby",
      "25 osób",
    ]);
  });
});

describe("workdays", () => {
  it("skips weekends and public holidays", () => {
    expect(nextWorkday("2026-11-20", new Set())).toBe("2026-11-23");
    expect(nextWorkday("2026-11-10", new Set(["2026-11-11"]))).toBe("2026-11-12");
    expect(workdaysAfter(TUESDAY, 5, new Set())).toEqual(["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"]);
  });

  it("asks once about visits 2–5 workdays ahead without a plan row", () => {
    const visits = [
      { startsOn: "2026-11-18", endsOn: "2026-11-18" },
      { startsOn: "2026-11-19", endsOn: "2026-11-20" },
      { startsOn: "2026-11-24", endsOn: "2026-11-24" },
      { startsOn: "2026-11-25", endsOn: "2026-11-25" },
    ];
    expect(headsUpDates(TUESDAY, visits, new Set(), new Set())).toEqual(["2026-11-19", "2026-11-20", "2026-11-24"]);
    expect(headsUpDates(TUESDAY, visits, new Set(["2026-11-19", "2026-11-20"]), new Set())).toEqual(["2026-11-24"]);
  });
});

describe("planCronAction", () => {
  it("posts only crowded days without a plan and never after a decline", () => {
    expect(planCronAction(null, true)).toBe("post");
    expect(planCronAction("heads_up", true)).toBe("post");
    expect(planCronAction(null, false)).toBe("skip");
    expect(planCronAction("declined", true)).toBe("skip");
    expect(planCronAction("posted", false)).toBe("refresh");
  });
});

describe("texts", () => {
  it("phrases days relative to today", () => {
    expect(dayPhrase("2026-11-18", TUESDAY)).toBe("jutro");
    expect(dayPhrase("2026-11-19", TUESDAY)).toBe("w czwartek");
    expect(dayPhrase("2026-12-01", TUESDAY)).toBe("we wtorek 1.12");
    expect(headsUpText("2026-11-19", TUESDAY, 9, ["zespół z Wrocławia"])).toBe(
      "W czwartek ~9 osób (przyjeżdża: zespół z Wrocławia). Przygotować plan biurek?",
    );
    expect(fallbackIntro("2026-11-18", TUESDAY, 3, [])).toBe("Jutro ~3 osoby w biurze. Plan biurek poniżej.");
  });
});

describe("plan message", () => {
  const input = {
    date: "2026-11-19",
    title: "Plan biurek — czwartek 19.11",
    intro: "Jutro ~9 osób, przyjeżdża Wrocław.",
    imageUrl: "https://example.test/desk-map/2026-11-19.png?v=3&sig=x",
    seats: [
      { label: "A1", name: "Kamil" },
      { label: "B2", name: "Gość z Wrocławia 1" },
    ],
    overflow: ["Gość z Wrocławia 2"],
    notes: ["<@U1>: właściciel wraca"],
    version: 3,
  };

  it("has the image with the versioned URL, the seat list, overflow and the four buttons", () => {
    const { text, blocks } = planMessage(input);
    expect(text).toContain("Plan biurek");
    const image = blocks.find((block) => block.type === "image")!;
    expect(image.image_url).toBe(input.imageUrl);
    expect(image.alt_text).toBe("Mapa biurek na 2026-11-19 — A1: Kamil, B2: Gość z Wrocławia 1");
    expect(JSON.stringify(blocks)).toContain("*A1* Kamil · *B2* Gość z Wrocławia 1");
    expect(JSON.stringify(blocks)).toContain("Brakuje biurek dla: Gość z Wrocławia 2");
    const actions = blocks.find((block) => block.type === "actions")!;
    expect(actions.elements.map((element: any) => [element.action_id, element.text.text, element.value])).toEqual([
      [PLAN_ACTION.away, "Nie będę", "2026-11-19"],
      [PLAN_ACTION.coming, "Jednak będę", "2026-11-19"],
      [PLAN_ACTION.change, "Zmień biurko", "2026-11-19"],
      [PLAN_ACTION.swap, "Zamień się z…", "2026-11-19"],
    ]);
    for (const id of actions.elements.map((element: any) => element.action_id)) expect(PLAN_ACTION_IDS.has(id)).toBe(true);
  });

  it("stays within Slack limits for a big office", () => {
    const seats = Array.from({ length: 300 }, (_, index) => ({ label: `D${index}`, name: `Osoba z bardzo długim nazwiskiem ${index}` }));
    const { blocks } = planMessage({ ...input, seats, overflow: seats.map((seat) => seat.name), notes: Array(20).fill("x".repeat(4000)) });
    expect(blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    for (const block of blocks) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionText);
      if (block.alt_text) expect(block.alt_text.length).toBeLessThanOrEqual(SLACK_LIMITS.altText);
      for (const element of block.elements ?? []) if (element.text?.text) expect(element.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(altText("2026-11-19", seats).length).toBe(SLACK_LIMITS.altText);
  });

  it("builds the heads-up and swap messages", () => {
    const headsUp = headsUpMessage("2026-11-19", "W czwartek ~9 osób. Przygotować plan biurek?");
    expect(headsUp.blocks[1].elements.map((element: any) => element.action_id)).toEqual([PLAN_ACTION.prepare, PLAN_ACTION.skip]);
    const request = { date: "2026-11-19", from: "u1", to: "u2", fromDesk: "d1", toDesk: "d2" };
    const swap = swapRequestMessage(request, "Zamienisz się?");
    const values = swap.blocks[1].elements.map((element: any) => element.value);
    expect(values.map(decodeSwap)).toEqual([request, request]);
    expect(decodeSwap("{}")).toBeNull();
    expect(decodeSwap("nope")).toBeNull();
  });

  it("caps modal options", () => {
    const view = selectModal({
      callbackId: "x",
      title: "Zmień biurko na bardzo długi tytuł",
      label: "Biurko",
      submit: "Zmień",
      options: Array.from({ length: 150 }, (_, index) => ({ label: `${"D".repeat(100)}${index}`, value: `D${index}` })),
      metadata: { date: "2026-11-19" },
    });
    const options = view.blocks[0].element.options;
    expect(options).toHaveLength(SLACK_LIMITS.options);
    expect(options[0].text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.optionText);
    expect(view.title.text.length).toBeLessThanOrEqual(24);
  });
});
