import { defineDynamic, defineInstructions } from "eve/instructions";
import { timeNote } from "../../lib/agent/system-prompt.ts";

export default defineDynamic({
  events: {
    "turn.started": () => defineInstructions({ role: "user", content: timeNote() }),
  },
});
