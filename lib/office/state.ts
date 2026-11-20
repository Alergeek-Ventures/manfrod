import { parseElements, shortNames, type OfficeElement } from "./model.ts";

export type DeskStatus = "owner_present" | "owner_away" | "taken" | "free";

export const DESK_STATUSES: DeskStatus[] = ["owner_present", "owner_away", "taken", "free"];

export type MapLayout = { id: string; name: string; width: number; height: number; elements: unknown };

export type MapDeskInput = {
  id: string;
  label: string;
  equipment: string[];
  active: boolean;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  ownerUserId: string | null;
  ownerName: string | null;
};

export type MapReservation = {
  deskId: string;
  userId: string | null;
  guestName: string | null;
  name: string | null;
  source: string;
};

export type MapDesk = {
  id: string;
  label: string;
  equipment: string[];
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  status: DeskStatus;
  name: string | null;
  fullName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  reservation: MapReservation | null;
};

export type MapState = {
  date: string;
  layout: { id: string; name: string; width: number; height: number; elements: OfficeElement[] };
  desks: MapDesk[];
};

export type PlacedDesk = MapDesk & { x: number; y: number };

export type MapStateInput = {
  date: string;
  layout: MapLayout;
  desks: MapDeskInput[];
  reservations: MapReservation[];
  awayUserIds: ReadonlySet<string>;
};

const reservationName = (reservation: MapReservation) => reservation.name ?? reservation.guestName ?? null;

export function deskStatus(
  desk: Pick<MapDeskInput, "ownerUserId">,
  reservation: MapReservation | null | undefined,
  awayUserIds: ReadonlySet<string>,
): DeskStatus {
  if (reservation) return "taken";
  if (desk.ownerUserId) return awayUserIds.has(desk.ownerUserId) ? "owner_away" : "owner_present";
  return "free";
}

export function buildMapState(input: MapStateInput): MapState {
  const active = input.desks.filter((desk) => desk.active);
  const byDesk = new Map(input.reservations.map((reservation) => [reservation.deskId, reservation]));

  const resolved = active.map((desk) => {
    const booked = byDesk.get(desk.id) ?? null;
    const reservation = booked?.userId && input.awayUserIds.has(booked.userId) ? null : booked;
    const status = deskStatus(desk, reservation, input.awayUserIds);
    const fullName = reservation ? reservationName(reservation) : desk.ownerUserId ? desk.ownerName : null;
    return { desk, reservation, status, fullName };
  });
  const names = shortNames(
    resolved.flatMap((entry) => (entry.fullName && !(entry.reservation && !entry.reservation.userId) ? [entry.fullName] : [])),
  );

  const desks: MapDesk[] = resolved.map(({ desk, reservation, status, fullName }) => ({
    id: desk.id,
    label: desk.label,
    equipment: desk.equipment,
    x: desk.x,
    y: desk.y,
    width: desk.width,
    height: desk.height,
    rotation: desk.rotation,
    status,
    name: fullName && !(reservation && !reservation.userId) ? (names.get(fullName.trim()) ?? fullName) : fullName,
    fullName,
    ownerUserId: desk.ownerUserId,
    ownerName: desk.ownerName,
    reservation,
  }));

  return {
    date: input.date,
    layout: {
      id: input.layout.id,
      name: input.layout.name,
      width: input.layout.width,
      height: input.layout.height,
      elements: parseElements(input.layout.elements),
    },
    desks: desks.sort((a, b) => a.label.localeCompare(b.label, "pl", { numeric: true })),
  };
}

export const isPlaced = (desk: MapDesk): desk is PlacedDesk => desk.x !== null && desk.y !== null;

export const placedDesks = (state: MapState): PlacedDesk[] => state.desks.filter(isPlaced);
