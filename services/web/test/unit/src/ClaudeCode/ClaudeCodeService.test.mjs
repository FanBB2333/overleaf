import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modulePath =
  "../../../../app/src/Features/ClaudeCode/ClaudeCodeService.mjs";

describe("ClaudeCodeService", function () {
  beforeEach(async function (ctx) {
    vi.useFakeTimers();

    ctx.watchCallback = null;
    ctx.watcher = {
      on: vi.fn(),
      close: vi.fn(),
    };
    ctx.nodeFs = {
      watch: vi.fn((_dir, _opts, cb) => {
        ctx.watchCallback = cb;
        return ctx.watcher;
      }),
      createWriteStream: vi.fn(),
    };

    ctx.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    vi.resetModules();

    vi.doMock("node-pty", () => ({
      default: {
        spawn: vi.fn(),
      },
    }));

    vi.doMock("@overleaf/logger", () => ({
      default: ctx.logger,
    }));

    vi.doMock("@overleaf/settings", () => ({
      default: {
        claudeCode: {
          workspaceBasePath: "/tmp",
        },
      },
    }));

    // Only the watcher is needed for these tests.
    vi.doMock("node:fs", () => ({
      default: ctx.nodeFs,
    }));

    // Avoid pulling in the real implementations; not needed for watcher tests.
    vi.doMock("../../../../app/src/Features/AI/AIService.mjs", () => ({
      default: {},
    }));
    vi.doMock("../../../../app/src/Features/History/HistoryManager.mjs", () => ({
      default: { promises: {} },
    }));
    vi.doMock(
      "../../../../app/src/Features/Editor/EditorController.mjs",
      () => ({
        default: { promises: {} },
      }),
    );
    vi.doMock(
      "../../../../app/src/Features/Project/ProjectEntityHandler.mjs",
      () => ({
        default: { promises: {} },
      }),
    );

    ctx.service = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not drop watcher events during the ignore window", async function (ctx) {
    const scheduleSpy = vi
      .spyOn(ctx.service, "scheduleWorkspaceSync")
      .mockImplementation(() => {});

    const session = {
      projectId: "project-123",
      workDir: "/tmp/workspace-project-123",
      binaryPaths: new Set(),
      ignoredWorkspacePaths: new Map([["/main.tex", Date.now() + 2000]]),
      workspaceFullSyncRequested: false,
      workspaceSyncTimer: null,
      workspaceSyncInProgress: false,
      workspaceSyncQueued: false,
      projectSyncInProgress: false,
    };

    ctx.service.startSynchronization(session);

    expect(ctx.nodeFs.watch).toHaveBeenCalledTimes(1);
    expect(ctx.watchCallback).toBeTypeOf("function");

    ctx.watchCallback("change", "main.tex");

    expect(session.workspaceFullSyncRequested).to.equal(true);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    clearInterval(session.projectSyncInterval);
    session.workspaceWatcher.close();
  });

  it("requests a full sync when the watcher omits the filename", async function (ctx) {
    const scheduleSpy = vi
      .spyOn(ctx.service, "scheduleWorkspaceSync")
      .mockImplementation(() => {});

    const session = {
      projectId: "project-123",
      workDir: "/tmp/workspace-project-123",
      binaryPaths: new Set(),
      ignoredWorkspacePaths: new Map(),
      workspaceFullSyncRequested: false,
      workspaceSyncTimer: null,
      workspaceSyncInProgress: false,
      workspaceSyncQueued: false,
      projectSyncInProgress: false,
    };

    ctx.service.startSynchronization(session);

    ctx.watchCallback("change", undefined);

    expect(session.workspaceFullSyncRequested).to.equal(true);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    clearInterval(session.projectSyncInterval);
    session.workspaceWatcher.close();
  });

  it("ignores shell history watcher noise", async function (ctx) {
    const scheduleSpy = vi
      .spyOn(ctx.service, "scheduleWorkspaceSync")
      .mockImplementation(() => {});

    const session = {
      projectId: "project-123",
      workDir: "/tmp/workspace-project-123",
      binaryPaths: new Set(),
      ignoredWorkspacePaths: new Map(),
      workspaceFullSyncRequested: false,
      workspaceSyncTimer: null,
      workspaceSyncInProgress: false,
      workspaceSyncQueued: false,
      projectSyncInProgress: false,
    };

    ctx.service.startSynchronization(session);

    ctx.watchCallback("change", ".bash_history");

    expect(session.workspaceFullSyncRequested).to.equal(false);
    expect(scheduleSpy).not.toHaveBeenCalled();

    clearInterval(session.projectSyncInterval);
    session.workspaceWatcher.close();
  });
});
