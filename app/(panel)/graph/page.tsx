import { listUsers } from "@/lib/accounts.ts";
import { getGraphData, getSoul, graphStats } from "@/lib/memory/nodes.ts";
import { listProjects } from "@/lib/memory/projects.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { clientIds } from "./actions.ts";
import { GraphClient } from "./graph-client.tsx";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const user = await requireAdmin();
  const [graph, soul, stats, users, projects, clients] = await Promise.all([
    getGraphData({ accessLevel: "internal" }),
    getSoul(user.id),
    graphStats(),
    listUsers(),
    listProjects(),
    clientIds(),
  ]);
  return (
    <GraphClient
      initialGraph={graph}
      initialStats={stats}
      soulId={soul?.id ?? null}
      currentUserId={user.id}
      users={users.map((candidate) => ({ id: candidate.id, label: candidate.name || candidate.email || candidate.id }))}
      projects={projects.map((project) => ({ id: project.id, name: project.name }))}
      clients={clients}
    />
  );
}
