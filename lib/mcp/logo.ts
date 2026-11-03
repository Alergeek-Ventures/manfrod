const FETCH_TIMEOUT_MS = 8_000;
const FALLBACK_PATHS = ["/apple-touch-icon.png", "/favicon.svg", "/favicon.ico"];
const SHARED_HOSTS = [
  "vercel.app",
  "netlify.app",
  "workers.dev",
  "pages.dev",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "github.io",
  "deno.dev",
  "run.app",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok.io",
];

export function siteOrigins(mcpUrl: string): string[] {
  const url = new URL(mcpUrl);
  const host = url.hostname;
  const labels = host.split(".");
  if (labels.length <= 2 || /^[\d.]+$/.test(host) || SHARED_HOSTS.some((shared) => host.endsWith(`.${shared}`))) return [url.origin];
  const secondLevel = labels.at(-1)!.length === 2 && /^(co|com|net|org|gov|edu|ac)$/.test(labels.at(-2)!);
  const root = labels.slice(secondLevel ? -3 : -2).join(".");
  return root === host ? [url.origin] : [`${url.protocol}//${root}`, url.origin];
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&") : null;
}

export function iconLinks(html: string, baseUrl: string): string[] {
  const icons: { url: string; rank: number; size: number }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rels = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attribute(tag, "href");
    const touch = rels.some((rel) => rel.startsWith("apple-touch-icon"));
    if (!href || (!touch && !rels.includes("icon"))) continue;
    const svg = attribute(tag, "type") === "image/svg+xml" || /\.svg([?#]|$)/i.test(href);
    const sizes = (attribute(tag, "sizes") ?? "").split(/\s+/).map((entry) => Number.parseInt(entry, 10));
    try {
      icons.push({ url: new URL(href, baseUrl).href, rank: touch ? 2 : svg ? 1 : 0, size: Math.max(0, ...sizes.filter(Number.isFinite)) });
    } catch {}
  }
  return icons.sort((a, b) => b.rank - a.rank || b.size - a.size).map((icon) => icon.url);
}

async function homepageIcons(origin: string): Promise<string[]> {
  try {
    const response = await fetch(origin, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) {
      await response.body?.cancel();
      return [];
    }
    return iconLinks(await response.text(), response.url);
  } catch {
    return [];
  }
}

async function isImage(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

export async function discoverLogo(mcpUrl: string): Promise<string | null> {
  for (const origin of siteOrigins(mcpUrl)) {
    const candidates = new Set([...(await homepageIcons(origin)), ...FALLBACK_PATHS.map((path) => origin + path)]);
    for (const candidate of candidates) if (await isImage(candidate)) return candidate;
  }
  return null;
}
