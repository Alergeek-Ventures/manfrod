import { parseArgs } from "node:util";
import { isSystemUser, listUsers } from "../lib/accounts.ts";
import { pool } from "../lib/db/index.ts";
import { getSoul } from "../lib/memory/nodes.ts";
import { draftWelcomeSoul, needsWelcomeSoul, saveWelcomeSoul } from "../lib/memory/souls.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, user: { type: "string" } } });
const filter = values.user?.toLowerCase();

const users = (await listUsers()).filter(
  (user) => !isSystemUser(user) && (!filter || user.id === filter || (user.name ?? "").toLowerCase().includes(filter)),
);

const summary = { drafted: 0, saved: 0, skipped: 0 };
for (const user of users) {
  if (!(await needsWelcomeSoul(user.id))) {
    summary.skipped += 1;
    continue;
  }
  const draft = await draftWelcomeSoul(user.id, user.name);
  if (!draft) {
    summary.skipped += 1;
    continue;
  }
  summary.drafted += 1;
  const current = await getSoul(user.id);
  console.log(`\n=== ${user.name ?? user.id}`);
  console.log(`current: ${current ? current.content.slice(0, 200) : "(none)"}`);
  console.log(`new:\n${draft}`);
  if (values.apply) {
    const soul = await saveWelcomeSoul(user.id, draft);
    summary.saved += 1;
    console.log(`saved as ${soul.id}`);
  }
}

console.log(
  `\n${users.length} user(s): ${summary.drafted} drafted, ${summary.saved} saved, ${summary.skipped} skipped${values.apply ? "" : " (dry run, pass --apply to save)"}`,
);
await pool().end();
