import type { OfficeElement } from "@/lib/office/model.ts";

export type EditorDesk = {
  id: string;
  label: string;
  locationNote: string | null;
  equipment: string[];
  active: boolean;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  ownerUserId: string | null;
};

export type EditorPerson = { id: string; name: string };

export type EditorLayout = {
  name: string;
  width: number;
  height: number;
  elements: OfficeElement[];
  planChannelId: string | null;
  crowdedThreshold: number;
};
