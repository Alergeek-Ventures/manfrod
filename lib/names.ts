export const foldName = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replaceAll("ł", "l").replace(/\s+/g, " ").trim();

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} i ${items.at(-1)}`;
}
