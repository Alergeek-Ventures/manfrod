import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const toNumber = (ip: string) => ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(address) === 4) {
    const value = toNumber(address);
    return BLOCKED_V4.some(([base, bits]) => (value & (~0 << (32 - bits))) >>> 0 === toNumber(base));
  }
  const lower = address.toLowerCase();
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

export async function publicUrlProblem(url: URL): Promise<string | null> {
  if (url.protocol !== "https:") return "only https:// URLs are allowed";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host) ? "private and internal addresses are not allowed" : null;
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal")) return "internal hostnames are not allowed";
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return `could not resolve ${host}`;
  }
  return addresses.some(({ address }) => isPrivateAddress(address)) ? "the host resolves to a private address" : null;
}
