import { describe, expect, it } from "vitest";
import { fileParts, parseSlackFiles, withFilesNote } from "../../lib/slack/files.ts";

const screenshot = {
  name: "Screenshot.png",
  mimetype: "image/png",
  size: 400_000,
  url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
  original_w: 1600,
  original_h: 1000,
  thumb_1024: "https://files.slack.com/files-tmb/T1-F1-abc/screenshot_1024.png",
};

describe("Slack files", () => {
  it("sends an image the model can read as it is", () => {
    const [part] = fileParts(parseSlackFiles([screenshot]));
    expect(part).toMatchObject({ type: "file", mediaType: "image/png", filename: "Screenshot.png" });
    expect(String(part.data)).toBe(screenshot.url_private);
  });

  it("falls back to the largest thumbnail for an image that is too big", () => {
    const [part] = fileParts(parseSlackFiles([{ ...screenshot, size: 5_000_000 }]));
    expect(String(part.data)).toBe(screenshot.thumb_1024);
    expect(part.mediaType).toBe("image/png");
  });

  it("only describes files the model cannot open and skips external ones", () => {
    const files = parseSlackFiles([
      { name: "data.zip", mimetype: "application/zip", url_private: "https://files.slack.com/x.zip" },
      { name: "Doc", mode: "external", url_private: "https://docs.google.com/x" },
    ]);
    expect(fileParts(files)).toEqual([]);
    expect(withFilesNote("", files)).toBe("[Attached file: data.zip (application/zip), which you cannot open]");
  });

  it("adds a note for each attachment after the text", () => {
    expect(withFilesNote("co tu widzisz?", parseSlackFiles([screenshot]))).toBe("co tu widzisz?\n[Attached image: Screenshot.png]");
  });
});
