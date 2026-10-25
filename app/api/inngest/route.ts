export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const agentOrigin = () => process.env.EVE_INTERNAL_ORIGIN ?? `http://127.0.0.1:${process.env.EVE_NEXT_PRODUCTION_PORT ?? "4274"}`;

async function forward(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await fetch(`${agentOrigin()}/api/inngest${url.search}`, { method: request.method, headers, body });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
