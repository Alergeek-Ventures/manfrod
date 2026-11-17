import { listReservationsForDate } from "../desks.ts";
import { recordedAwayUserIds } from "./away.ts";
import { loadOffice } from "./layout.ts";
import { renderPng } from "./render.ts";
import { buildMapState, type MapState } from "./state.ts";

export async function loadMapState(date: string, options: { awayUserIds?: ReadonlySet<string> } = {}): Promise<MapState> {
  const [office, reservations, away] = await Promise.all([
    loadOffice(),
    listReservationsForDate(date),
    options.awayUserIds ?? recordedAwayUserIds(date),
  ]);
  return buildMapState({
    date,
    layout: office.layout,
    desks: office.desks,
    reservations: reservations.map((reservation) => ({
      deskId: reservation.deskId,
      userId: reservation.userId,
      guestName: reservation.guestName,
      name: reservation.name,
      source: reservation.source,
    })),
    awayUserIds: away,
  });
}

export async function renderDeskMapPng(date: string, options: { awayUserIds?: ReadonlySet<string>; title?: string } = {}): Promise<Buffer> {
  return renderPng(await loadMapState(date, options), { title: options.title });
}
