import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonRequest } from "./custom-desktop.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const devData = join(root, ".maestro", "custom-dev-data");
const manifest = join(devData, "feature-acceptance.json");
if (existsSync(manifest)) throw new Error(`Existing acceptance project retained: ${manifest}`);
const runtime = JSON.parse(readFileSync(join(devData, "daemon", "runtime.json")));
const directory = mkdtempSync(join(tmpdir(), "maestro-feature-acceptance-"));
const project = directory.replaceAll("\\", "/");
const git = (...args) => execFileSync("git", ["-C", directory, ...args], { windowsHide: true });
git("init", "-b", "main");
git("config", "user.name", "Maestro acceptance");
git("config", "user.email", "acceptance@example.invalid");
git("config", "commit.gpgsign", "false");
writeFileSync(
  join(directory, "package.json"),
  JSON.stringify(
    {
      name: "maestro-arithmetic-acceptance",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(directory, "README.md"),
  "# Maestro Custom ACP acceptance\nAn isolated local arithmetic project. No remote, dependencies or network installation needed.\n",
);
writeFileSync(
  join(directory, "AGENTS.md"),
  "Stay inside this isolated fixture and its worktrees. Do not access parent repositories, credentials or unrelated files. Never push or merge branches. Use Node's built-in test runner. Report exact test outcomes, including deliberate fault injection. The first addition implementation intentionally contains an off-by-one defect to exercise independent review; only rework removes it.\n",
);
git("add", ".");
git("commit", "-m", "Initialize isolated ACP acceptance project");
mkdirSync(join(directory, ".maestro"));
writeFileSync(
  join(directory, ".maestro", "custom-owner.json"),
  JSON.stringify({ identifier: "com.memocan040.maestro.custom" }),
);
const profiles = [
  { id: "acceptance-lead", name: "Codex orchestrator", role: "Planner", agent_id: "codex-acp" },
  { id: "acceptance-claude", name: "Claude worker", role: "Coder", agent_id: "claude-acp" },
  { id: "acceptance-cursor", name: "Cursor worker", role: "Coder", agent_id: "cursor" },
  {
    id: "acceptance-reviewer",
    name: "Codex reviewer",
    role: "Reviewer",
    agent_id: "codex-acp",
    role_prompt:
      "Review independently, run node --test and check the task and feature criteria. Detect the deliberate addition off-by-one defect, give precise reproducible findings, and request correction. After rework verify the fix. Start the verdict exactly APPROVED or CHANGES REQUESTED. Do not modify code or merge. Report actual test commands and outcomes.",
  },
];
writeFileSync(join(directory, ".maestro", "profiles.json"), JSON.stringify({ profiles }, null, 2));
const request = (operation) =>
  daemonRequest(
    runtime,
    { orchestration: { project_path: project, operation } },
    "orchestration_ok",
  );
for (const profile of profiles) {
  await request({
    action: "save_member",
    member: {
      id: profile.id,
      profile_id: profile.id,
      name: profile.name,
      strengths:
        profile.role === "Reviewer" ? "Independent test evidence" : "ACP arithmetic acceptance",
      enabled: true,
      orchestrator: profile.role === "Planner",
      worker: profile.role === "Coder",
      reviewer: profile.role === "Reviewer",
      max_sessions: 1,
      priority: 0,
    },
  });
}
const snapshot = await request({
  action: "create_feature",
  title: "Arithmetic: ACP review and rework acceptance",
  goal: "Plan exactly three tasks, do not implement. Task sum uses acceptance-claude: sum.js exports sum(a,b); ask the orchestrator whether negative numbers are supported using send_feature_message, then wait in the same session. The answer is yes. On the FIRST coding round intentionally implement a+b+1 and report this declared fault injection so independent review detects it; the rework round removes it and reruns tests. Task product uses acceptance-cursor: product.js exports product(a,b), with built-in Node tests; it is independent of sum. Task combined uses acceptance-cursor and depends on BOTH sum and product: index.js re-exports both, add combined tests. Assign no work to the reviewer; it is independently selected by team configuration. Submit this plan once with submit_feature_plan and stop for human approval. In later turns answer worker questions, acknowledge each message and coordinate the existing pipeline; never approve plans, integrate commits or poll. Every worker must test and commit its own work. No dependencies, external tools, remote or push. Human integration approval is mandatory before combined can start.",
  acceptance: [
    "sum(2,3)=5 and sum(-2,3)=1",
    "product(2,3)=6 and product(-2,3)=-6",
    "Two different worker harnesses, same-session question/answer, independent review and correction",
    "All tests pass before human integration approval; main is never automatically merged",
  ],
  orchestrator_member: "acceptance-lead",
  allowed_members: ["acceptance-claude", "acceptance-cursor", "acceptance-reviewer"],
  max_parallel: 2,
  base_branch: "main",
});
const feature = snapshot.features[0];
writeFileSync(
  manifest,
  JSON.stringify(
    {
      project,
      feature_id: feature.id,
      orchestrator_task: feature.orchestrator_task,
      status: feature.status,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ manifest, project, feature_id: feature.id, status: feature.status }, null, 2),
);
if (process.argv.includes("--plan")) {
  await daemonRequest(
    runtime,
    {
      start_task: {
        project_path: project,
        task_id: feature.orchestrator_task,
        role: "Planner",
        unattended: false,
        respect_capacity: true,
      },
    },
    "start_task_ok",
    120_000,
  );
  console.log("One real orchestrator planning turn started. Workers require human plan approval.");
}
