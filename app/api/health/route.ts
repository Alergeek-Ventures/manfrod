import { healthy } from "../../../lib/db/index.ts";

export const dynamic = "force-dynamic";

async function agentUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.EVE_NEXT_PRODUCTION_PORT ?? "4274"}/api/inngest`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function GET() {
  const [database, agent] = await Promise.all([healthy(), process.env.NODE_ENV === "production" ? agentUp() : Promise.resolve(true)]);
  const services = { agent: agent ? "ok" : "down", database: database ? "ok" : "down" };
  return Response.json({ status: "ok", timestamp: new Date().toISOString(), services }, { status: agent && database ? 200 : 503 });
}
