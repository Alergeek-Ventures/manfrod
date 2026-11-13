import { installUrl } from "../../../lib/github/api.ts";
import { startOauth } from "../connect/start.ts";

export async function GET() {
  return startOauth(installUrl);
}
