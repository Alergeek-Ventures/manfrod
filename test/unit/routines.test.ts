import { describe, expect, it } from "vitest";
import { describePeriod, holidayPeriods, prompt, type HolidayAction, type Period } from "../../lib/holidays.ts";
import { fill, get, list, listCronRoutines, routineText, section } from "../../lib/routines.ts";

const USED_SECTIONS: [string, string | undefined][] = [
  ["proactive-style", undefined],
  ["work-start", "Message"],
  ["work-start", "When they reply"],
  ["evening-hours", "Message"],
  ["evening-hours", "When they reply"],
  ["weekly-wrap-up", "Message"],
  ["weekly-wrap-up", "When they reply"],
  ["absence-follow-up", "Message"],
  ["absence-follow-up", "When they reply"],
  ["weekly-project-summary", "Message"],
  ["holiday-check", "Ask"],
  ["holiday-check", "Bridge days"],
  ["holiday-check", "Reminder"],
  ["holiday-check", "When they reply"],
];

describe("routines", () => {
  it("are folders with a ROUTINE.md, like skills", () => {
    const names = list().map((routine) => routine.name);
    expect(names).toEqual(expect.arrayContaining(["leave-digest", "firmowid-morning-checkin", "work-start", "holiday-check"]));
    expect(listCronRoutines().map((routine) => routine.name)).toContain("leave-digest");
    expect(get("leave-digest")?.channel).toBeTruthy();
  });

  it("have every section the code reads", () => {
    for (const [name, heading] of USED_SECTIONS) expect(routineText(name, heading).length, `${name} ${heading}`).toBeGreaterThan(20);
  });

  it("fail loudly when a section is missing", () => {
    expect(() => routineText("work-start", "Nope")).toThrow('Routine work-start has no "## Nope" section.');
    expect(() => routineText("no-such-routine")).toThrow("Routine no-such-routine is missing");
  });

  it("read one section and fill placeholders", () => {
    expect(section("## A\none\n## B\ntwo\n", "A")).toBe("one");
    expect(section("## A\none\n## B\ntwo\n", "C")).toBeNull();
    expect(fill("hi {{name}} {{other}}", { name: "Ala" })).toBe("hi Ala {{other}}");
  });
});

function previousPrompt(period: Period, action: HolidayAction): string {
  const opening =
    action === "ask"
      ? `[Proaktywnie: zbliżające się święta]\nZbliża się wolne, a ta osoba nie ma nic zapisanego na ten czas:\n${describePeriod(period)}`
      : `[Proaktywnie: przypomnienie o świętach]\nKilka dni temu ta osoba nie wiedziała jeszcze, co robi w tym czasie:\n${describePeriod(period)}`;
  const ask =
    action === "ask"
      ? `Napisz jedną krótką, ciepłą wiadomość jak pomocny asystent: przypomnij o wolnym${
          period.bridges.length > 0
            ? ", podsuń dni pomostowe (ile dni urlopu daje ile dni wolnego) i zaproponuj, że od razu zapiszesz urlop"
            : ""
        }, i zapytaj, czy w święto ma wolne, czy pracuje. Bez listy pytań i bez nadmiaru emoji.`
      : "Przypomnij się raz, jednym krótkim zdaniem, bez naciskania. Więcej o to nie zapytasz.";
  return `${opening}

${ask}

Gdy odpowie, zapisz to i nie dopytuj więcej:
- bierze urlop (np. na dni pomostowe) → report-vacation na te dni, potem record-holiday-plan(period: "${period.start}", status: "off")
- ma wolne tylko w święto → record-holiday-plan(period: "${period.start}", status: "off")
- pracuje w święto → record-holiday-plan(period: "${period.start}", status: "working")
- jeszcze nie wie → record-holiday-plan(period: "${period.start}", status: "unsure")
- nie chce dostawać takich pytań → set-proactive-preferences z kind "holidays" wyłączonym`;
}

describe("holiday check prompt", () => {
  const periods = holidayPeriods([
    { date: "2026-06-04", name: "Boże Ciało" },
    { date: "2026-12-24", name: "Wigilia" },
    { date: "2026-12-25", name: "Boże Narodzenie" },
    { date: "2026-12-26", name: "Drugi dzień świąt" },
  ]);

  it("reads exactly like the prompt it replaced, with and without bridge days", () => {
    expect(periods.some((period) => period.bridges.length > 0)).toBe(true);
    expect(periods.some((period) => period.bridges.length === 0)).toBe(true);
    for (const period of periods) {
      for (const action of ["ask", "reask"] as HolidayAction[]) expect(prompt(period, action)).toBe(previousPrompt(period, action));
    }
  });
});
