import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const EVE_PORT = process.env.EVE_DEV_PORT ?? "4274";
const APP_PORT = process.env.PORT ?? "35233";
const EVE_ORIGIN = `http://127.0.0.1:${EVE_PORT}`;
const ACK_DEADLINE_MS = 2_500;

const appToken = process.env.SLACK_APP_TOKEN;
if (!appToken?.startsWith("xapp-")) {
  console.error("dev-slack: SLACK_APP_TOKEN (xapp-…) is required for Socket Mode");
  process.exit(1);
}

const signingSecret = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  SLACK_SIGNING_SECRET: signingSecret,
  INNGEST_DEV: process.env.INNGEST_DEV ?? "1",
  DISABLE_CRONS: process.env.DISABLE_CRONS ?? "1",
  EVE_BASE_URL: EVE_ORIGIN,
  EVE_INTERNAL_ORIGIN: EVE_ORIGIN,
  PORT: APP_PORT,
};

const children = [
  spawn("node_modules/.bin/eve", ["dev", "--port", EVE_PORT, "--no-ui", "--no-default-extensions", "--resume"], { env, stdio: "inherit" }),
  spawn("node_modules/.bin/next", ["dev", "--port", APP_PORT], { env, stdio: "inherit" }),
];

const shutdown = (code) => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const child of children) child.on("exit", (code) => shutdown(code ?? 1));

function encode(type, payload) {
  if (type === "events_api") return { body: JSON.stringify(payload), contentType: "application/json" };
  if (type === "interactive") {
    return { body: `payload=${encodeURIComponent(JSON.stringify(payload))}`, contentType: "application/x-www-form-urlencoded" };
  }
  return { body: new URLSearchParams(payload).toString(), contentType: "application/x-www-form-urlencoded" };
}

async function forward(type, payload) {
  const { body, contentType } = encode(type, payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await fetch(`${EVE_ORIGIN}/eve/v1/slack`, {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body,
  });
  const text = await response.text();
  if (!response.ok) console.error(`dev-slack: ${type} → ${response.status} ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

async function openSocketUrl() {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`apps.connections.open: ${result.error}`);
  return result.url;
}

async function waitForEve() {
  for (;;) {
    try {
      await fetch(EVE_ORIGIN);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function connect(attempt = 0) {
  let url;
  try {
    url = await openSocketUrl();
  } catch (error) {
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    console.error(`dev-slack: ${error.message}, retrying in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
    return;
  }

  const socket = new WebSocket(url);
  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") return console.log("dev-slack: Socket Mode connected");
    if (message.type === "disconnect") return socket.close();
    if (!message.envelope_id) return;

    const ack = (payload) => socket.send(JSON.stringify(payload ? { envelope_id: message.envelope_id, payload } : { envelope_id: message.envelope_id }));
    let acked = false;
    const fallback = setTimeout(() => {
      acked = true;
      ack();
    }, ACK_DEADLINE_MS);
    try {
      const payload = await forward(message.type, message.payload);
      if (!acked) ack(message.accepts_response_payload ? payload : undefined);
    } catch (error) {
      console.error(`dev-slack: forwarding ${message.type} failed: ${error.message}`);
      if (!acked) ack();
    } finally {
      clearTimeout(fallback);
    }
  });
  socket.addEventListener("close", () => {
    console.log("dev-slack: socket closed, reconnecting");
    setTimeout(() => connect(0), 1_000);
  });
  socket.addEventListener("error", () => {});
}

await waitForEve();
await connect();
