import { defineTool } from "eve/tools";
import { noReply } from "eve/tools/no_reply";

export default defineTool({
  ...noReply(),
  description:
    "End your turn without posting anything. Use it when nothing should be said: a scheduled check or task check finds nothing worth posting, an action you already took is the whole answer, or a thread message is meant for other people and you have nothing to add. Never use it when someone asked you something or is waiting for your answer, and never post that you are staying quiet instead of calling it.",
});
