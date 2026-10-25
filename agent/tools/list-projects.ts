import { z } from "zod";
import { listProjects } from "../../lib/memory/projects.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List all known projects (name + slug). Use when you need to confirm or disambiguate a project the user named before filtering notes by it (e.g. via list-recent-notes' `project` parameter).",
  inputSchema: z.object({}),
  async execute() {
    const projects = await listProjects();
    if (projects.length === 0) return "No projects configured.";
    return `Projects:\n${projects.map((project) => `- ${project.name} (slug: ${project.slug})`).join("\n")}`;
  },
});
