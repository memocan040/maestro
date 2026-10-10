import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (name, payload) =>
      (window as unknown as { __TAURI__: { core: { invoke: Function } } }).__TAURI__.core.invoke(
        name,
        payload,
      ),
    command,
    args,
  ) as Promise<T>;
}

// Native W3C commands avoid the external service's embedded-plugin focus helper.
async function nativeRequest(path: string, body: unknown) {
  const options = browser.options;
  const response = await fetch(
    `${options.protocol}://${options.hostname}:${options.port}/session/${browser.sessionId}/${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const result = await response.json();
  if (result.value?.error) throw new Error(result.value.message);
  return result.value;
}
async function element(selector: string) {
  const result = await nativeRequest("element", {
    using: selector.startsWith("//") ? "xpath" : "css selector",
    value: selector,
  });
  return result["element-6066-11e4-a52e-4f735466cecf"] as string;
}
async function click(selector: string) {
  const matches = await nativeRequest("elements", {
    using: selector.startsWith("//") ? "xpath" : "css selector",
    value: selector,
  });
  let lastError: unknown;
  for (const match of matches) {
    try {
      await nativeRequest(`element/${match["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
      return;
    } catch (error) {
      // Inactive animated views can retain another copy of the same toolbar.
      if (!/not interactable|click intercepted/i.test(String(error))) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No clickable element: ${selector}`);
}
async function button(text: string) {
  await click(`//button[normalize-space(.)='${text}']`);
}
async function fill(selector: string, text: string) {
  const id = await element(selector);
  await nativeRequest(`element/${id}/clear`, {});
  await nativeRequest(`element/${id}/value`, { text });
}
async function visible(text: string, timeout = 15_000) {
  await browser.waitUntil(
    () => browser.execute((value) => document.body.innerText.includes(value), text),
    { timeout },
  );
}

async function closeDialog() {
  await browser.keys("Escape");
  await browser.waitUntil(() =>
    browser.execute(() => !document.querySelector('[data-slot="dialog-overlay"]')),
  );
}

describe("Custom orchestration in the real desktop app", function () {
  this.timeout(600_000);
  let projectId: number;

  before(async () => {
    const path = join(process.env.MAESTRO_E2E_DATA_DIR!, "orchestration-demo");
    mkdirSync(path);
    execFileSync("git", ["init", "-b", "main", path]);
    writeFileSync(join(path, "README.md"), "# Isolated Maestro Custom GUI acceptance project\n");
    execFileSync("git", ["-C", path, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      path,
      "-c",
      "user.name=Maestro E2E",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "-m",
      "Initial fixture",
    ]);
    const project = await invoke<{ id: number }>("create_project", {
      path: path.replaceAll("\\", "/"),
      connection: { type: "local" },
    });
    projectId = project.id;
    const settings = await invoke<Record<string, unknown>>("get_settings", {});
    await invoke("save_settings", { settings: { ...settings, reduce_motion: true } });
    // Native directory pickers cannot be driven by WebDriver. Prepare only the
    // fixture/profiles through IPC; all team and feature actions below use real GUI controls.
    await invoke("save_agent_profiles", {
      projectId,
      document: {
        profiles: [
          { id: "gui-planner", name: "GUI planner", role: "Planner", agent_id: "codex-acp" },
          { id: "gui-worker", name: "GUI worker", role: "Coder", agent_id: "claude-acp" },
          { id: "gui-reviewer", name: "GUI reviewer", role: "Reviewer", agent_id: "codex-acp" },
          { id: "cursor-1", name: "Cursor one", role: "Coder", agent_id: "cursor" },
          { id: "cursor-2", name: "Cursor two", role: "Coder", agent_id: "cursor" },
          { id: "cursor-3", name: "Cursor three", role: "Coder", agent_id: "cursor" },
          { id: "gemini", name: "Gemini member", role: "Coder", agent_id: "gemini" },
          { id: "opencode", name: "OpenCode member", role: "Coder", agent_id: "opencode" },
          { id: "agy", name: "AGY member", role: "Coder", agent_id: "antigravity-acp" },
        ],
      },
    });
    await browser.refresh();
    await visible("orchestration-demo", 120_000);
    await click("[data-home-project] > button");
    try {
      await visible("Features / New Feature", 120_000);
    } catch (error) {
      console.log(
        "Before-hook GUI state:",
        await browser.execute(() => document.body.innerText.slice(0, 6000)),
      );
      throw error;
    }
  });

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await browser.saveScreenshot(join(tmpdir(), "maestro-custom-gui-failure.png"));
      console.log(
        "GUI failure state:",
        await browser.execute(() => document.body.innerText.slice(0, 6000)),
      );
    }
  });

  it("opens Agent Team, adds profiles, creates a feature and preserves it after app restart", async () => {
    if (await browser.execute(() => !!document.querySelector('[role="dialog"]'))) {
      console.log(
        "Project opening dialog:",
        await browser.execute(() => document.querySelector('[role="dialog"]')?.textContent),
      );
      await closeDialog();
    }
    await click('[aria-label="Settings"]');
    await click("//*[@role='dialog']//button[normalize-space(.)='Agents']");
    await visible("Agent Team");
    for (const [name, provider] of [
      ["GUI planner", "codex-acp"],
      ["GUI worker", "claude-acp"],
      ["GUI reviewer", "codex-acp"],
      ["Cursor one", "cursor"],
      ["Cursor two", "cursor"],
      ["Cursor three", "cursor"],
      ["Gemini member", "gemini"],
      ["OpenCode member", "opencode"],
      ["AGY member", "antigravity-acp"],
    ]) {
      await button("+ Add Agent");
      const role =
        name === "GUI planner" ? "orchestrator" : name === "GUI reviewer" ? "reviewer" : "worker";
      await click(`//select[@aria-label='Team provider']/option[@value='${provider}']`);
      await click(`//select[@aria-label='Team profile']/option[normalize-space(.)='${name}']`);
      await fill('[aria-label="Member name"]', name);
      if (role !== "worker") {
        await click('[aria-label="Team role worker"]');
        await click(`[aria-label="Team role ${role}"]`);
      }
      await button("Save agent");
      await browser.waitUntil(
        async () => {
          const snapshot = await invoke<{ members: { name: string }[] }>("orchestration", {
            projectId,
            operation: { action: "snapshot" },
          });
          return snapshot.members.some((member) => member.name === name);
        },
        { timeout: 60_000 },
      );
    }
    await browser.saveScreenshot(join(tmpdir(), "maestro-custom-agent-team.png"));
    await closeDialog();
    await button("Features / New Feature");
    await fill('[aria-label="Feature title"]', "GUI verified feature");
    await fill(
      '[aria-label="Feature goal"]',
      "Verify the real desktop feature workflow entry point",
    );
    await fill(
      '[aria-label="Acceptance criteria"]',
      "State survives app restart\nHuman approvals remain required",
    );
    await click("//select/option[normalize-space(.)='GUI planner']");
    await button("Create feature");
    await visible("GUI verified feature · Planning");
    await visible("Start planning");
    await visible("Team Chat");
    await click("//select[@aria-label='Chat message kind']/option[@value='note']");
    await fill('[aria-label="Team chat message"]', "GUI chat note survives restart");
    await button("Send message");
    await visible("GUI chat note survives restart");
    await browser.saveScreenshot(join(tmpdir(), "maestro-custom-feature.png"));
    // Do not start paid/provider work in this GUI-entry test. Real harness acceptance
    // is a separate lane; creating a feature alone must never start its orchestrator.
    await browser.reloadSession();
    await browser.waitUntil(() => browser.execute(() => document.readyState === "complete"));
    if (
      !(await browser.execute(() => document.body.innerText.includes("Features / New Feature")))
    ) {
      await visible("orchestration-demo", 120_000);
      await click("[data-home-project] > button");
    }
    await visible("Features / New Feature", 120_000);
    const restored = await invoke<{ members: { id: string; profile_id: string }[] }>(
      "orchestration",
      {
        projectId,
        operation: { action: "snapshot" },
      },
    );
    expect(restored.members.length).toBe(9);
    expect(new Set(restored.members.map((m) => m.id)).size).toBe(9);
    expect(new Set(restored.members.map((m) => m.profile_id)).size).toBe(9);
    if (await browser.execute(() => !!document.querySelector('[role="dialog"]'))) {
      await closeDialog();
    }
    await button("Features / New Feature");
    await button("GUI verified feature · Planning");
    expect(await browser.execute(() => document.body.innerText)).toContain("GUI verified feature");
    await visible("Start planning");
    await visible("GUI chat note survives restart");
    const pendingPlan = await invoke<{
      features: { id: string; orchestrator_task: number; task_ids: number[] }[];
    }>("orchestration", {
      projectId,
      operation: { action: "snapshot" },
    });
    const waitingFeature = pendingPlan.features[0];
    await invoke("orchestration", {
      projectId,
      operation: {
        action: "submit_plan",
        feature_id: waitingFeature.id,
        tasks: [
          {
            key: "gui-worker",
            title: "GUI plan awaiting user",
            instructions: "Never started by this GUI test",
            acceptance: ["Requires user approval"],
            member_id: restored.members.find((m) => m.profile_id === "gui-worker")!.id,
            depends_on: [],
          },
        ],
      },
    });
    await closeDialog();
    await button("Review pending plan (1)");
    await visible("Approve plan and start workers");
    await visible("GUI plan awaiting user");
    await button("Orchestrator session");
    await visible("No active orchestrator session");
    await visible("GUI chat note survives restart");
    const unapproved = await invoke<{ features: { task_ids: number[] }[] }>("orchestration", {
      projectId,
      operation: { action: "snapshot" },
    });
    expect(unapproved.features[0].task_ids).toEqual([]);
    await browser.saveScreenshot(join(tmpdir(), "maestro-custom-plan-approval.png"));
    // Inspect the gate; never approve or start this fixture's workers.
    await button("cancel");
    await visible("GUI verified feature · Cancelled");
    await closeDialog();
    await visible("Features / New Feature");
  });

  after(async () => {
    if (projectId) await invoke("delete_project", { projectId });
  });
});
