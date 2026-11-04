import { defineSandbox } from "eve/sandbox";
import { AttachmentSandbox } from "./lib/attachment-sandbox.ts";

export const environment = AttachmentSandbox.environment({});

export default defineSandbox(() => environment.open());
