import { defineSandbox } from "eve/sandbox";
import { E2BSandbox } from "../../lib/e2b-sandbox.ts";

export const environment = E2BSandbox.environment({ timeoutMs: 30 * 60_000 });

export default defineSandbox(() => environment.open({ networkPolicy: "deny-all" }));
