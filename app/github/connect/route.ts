import { authorizeUrl } from "../../../lib/github/oauth.ts";
import { startOauth } from "./start.ts";

export async function GET() {
  return startOauth(async (state) => authorizeUrl(state));
}
