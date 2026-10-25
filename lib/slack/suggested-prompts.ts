import type { User } from "../db/schema.ts";
import { listUserReservations } from "../desks.ts";
import { logger } from "../log.ts";
import { getChannelInfo } from "./api.ts";
import { userContext } from "./state.ts";

const log = logger("SuggestedPrompts");
const MAX_PROMPTS = 4;

export interface Prompt {
  title: string;
  message: string;
}

const DEFAULTS: Prompt[] = [
  { title: "Co mam na dziś?", message: "Co mam dziś zaplanowane? Przypomnienia, spotkania, rezerwacje." },
  { title: "Zgłoś urlop", message: "Chcę zgłosić urlop - " },
  { title: "Kto jest nieobecny?", message: "Kto z zespołu jest nieobecny w tym tygodniu?" },
  { title: "Przypomnij mi", message: "Przypomnij mi jutro rano o " },
];

async function currentChannelPrompt(slackUserId: string | null): Promise<Prompt | null> {
  if (!slackUserId) return null;
  const channelId = userContext.get(slackUserId)?.channel_id;
  if (typeof channelId !== "string" || channelId.startsWith("D")) return null;
  const name = (await getChannelInfo(channelId))?.name;
  if (typeof name !== "string") return null;
  return { title: `Streść #${name}`, message: `Streść mi, co działo się na #${name} w ciągu ostatniej doby.` };
}

async function deskPrompt(user: User | null): Promise<Prompt | null> {
  if (!user) return null;
  let reservations: Awaited<ReturnType<typeof listUserReservations>> = [];
  try {
    reservations = await listUserReservations(user.id);
  } catch (error) {
    log.warn(`SuggestedPrompts: desk lookup failed: ${(error as Error).message}`);
  }
  const [next] = reservations;
  return next
    ? { title: "Odwołaj biurko", message: `Odwołaj moją rezerwację biurka na ${next.date}.` }
    : { title: "Zarezerwuj biurko", message: "Zarezerwuj mi biurko na jutro." };
}

export async function buildPrompts(user: User | null, slackUserId: string | null): Promise<Prompt[]> {
  const contextual = [await currentChannelPrompt(slackUserId), await deskPrompt(user)].filter((prompt): prompt is Prompt => prompt !== null);
  const seen = new Set<string>();
  return [...contextual, ...DEFAULTS].filter((prompt) => (seen.has(prompt.title) ? false : (seen.add(prompt.title), true))).slice(0, MAX_PROMPTS);
}
