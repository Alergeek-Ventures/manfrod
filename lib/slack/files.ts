import type { FilePart } from "ai";

export interface SlackFile {
  name: string;
  mimeType: string;
  size: number | null;
  url: string | null;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
}

export const MAX_FILES_PER_TURN = 10;

const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const THUMBNAIL_KEYS = ["thumb_1024", "thumb_960", "thumb_800", "thumb_720", "thumb_480", "thumb_360"];
const THUMBNAIL_TYPES: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp" };

const string = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function parseSlackFiles(raw: unknown): SlackFile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (file): file is Record<string, unknown> =>
        typeof file === "object" && file !== null && file.mode !== "external" && file.mode !== "tombstone" && file.is_external !== true,
    )
    .map((file) => ({
      name: string(file.name) ?? string(file.title) ?? "file",
      mimeType: string(file.mimetype) ?? "application/octet-stream",
      size: number(file.size),
      url: string(file.url_private),
      width: number(file.original_w),
      height: number(file.original_h),
      thumbnail: THUMBNAIL_KEYS.map((key) => string(file[key])).find((url) => url !== null) ?? null,
    }));
}

function thumbnailType(url: string): string {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return THUMBNAIL_TYPES[extension] ?? "image/jpeg";
}

function fitsModel(file: SlackFile): boolean {
  return (file.size ?? 0) <= MAX_IMAGE_BYTES && Math.max(file.width ?? 0, file.height ?? 0) <= MAX_IMAGE_SIDE;
}

function readableSource(file: SlackFile): { url: string; mediaType: string } | null {
  if (NATIVE_IMAGE_TYPES.has(file.mimeType) && file.url && fitsModel(file)) return { url: file.url, mediaType: file.mimeType };
  if (file.mimeType.startsWith("image/") && file.thumbnail) return { url: file.thumbnail, mediaType: thumbnailType(file.thumbnail) };
  if (file.mimeType === "application/pdf" && file.url && (file.size ?? 0) <= MAX_PDF_BYTES) {
    return { url: file.url, mediaType: file.mimeType };
  }
  return null;
}

function kind(file: SlackFile): string {
  if (file.mimeType.startsWith("image/")) return "image";
  if (file.mimeType === "application/pdf") return "PDF";
  return "file";
}

function filePart(file: SlackFile): FilePart | null {
  const source = readableSource(file);
  if (!source) return null;
  return { type: "file", mediaType: source.mediaType, filename: file.name, data: new URL(source.url) };
}

export function filesNote(files: SlackFile[]): string {
  return files
    .map((file) =>
      readableSource(file)
        ? `[Attached ${kind(file)}: ${file.name}]`
        : `[Attached ${kind(file)}: ${file.name} (${file.mimeType}), which you cannot open]`,
    )
    .join("\n");
}

export function withFilesNote(text: string, files: SlackFile[]): string {
  return [text, filesNote(files)].filter((part) => part !== "").join("\n");
}

export function fileParts(files: SlackFile[]): FilePart[] {
  return files
    .map(filePart)
    .filter((part) => part !== null)
    .slice(-MAX_FILES_PER_TURN);
}
