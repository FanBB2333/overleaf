import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import MockRequest from "../helpers/MockRequest.mjs";
import MockResponse from "../helpers/MockResponse.mjs";

const modulePath =
  "../../../../app/src/Features/ClaudeCode/ClaudeCodeController.mjs";
const tokenModulePath =
  "../../../../app/src/Features/ClaudeCode/fileEditorToken.mjs";

describe("ClaudeCodeController", function () {
  beforeEach(async function (ctx) {
    ctx.originalHome = process.env.HOME;
    ctx.originalSessionSecret = process.env.OVERLEAF_SESSION_SECRET;
    ctx.originalClaudeCodeHome = process.env.CLAUDE_CODE_HOME;

    process.env.HOME = "";
    process.env.OVERLEAF_SESSION_SECRET = "test-file-editor-secret";
    delete process.env.CLAUDE_CODE_HOME;

    ctx.SessionManager = {
      getLoggedInUserId: vi.fn().mockReturnValue("user-123"),
    };
    ctx.ClaudeCodeService = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      destroySession: vi.fn(),
    };
    ctx.logger = {
      error: vi.fn(),
    };

    vi.resetModules();

    vi.doMock(
      "../../../../app/src/Features/Authentication/SessionManager.mjs",
      () => ({
        default: ctx.SessionManager,
      }),
    );

    vi.doMock(
      "../../../../app/src/Features/ClaudeCode/ClaudeCodeService.mjs",
      () => ({
        default: ctx.ClaudeCodeService,
      }),
    );

    vi.doMock("@overleaf/logger", () => ({
      default: ctx.logger,
    }));

    ctx.controller = (await import(modulePath)).default;
    ctx.req = new MockRequest(vi);
    ctx.res = new MockResponse(vi);
    ctx.verifyFileEditorToken = (await import(tokenModulePath)).verifyFileEditorToken;
  });

  afterEach(function (ctx) {
    if (ctx.originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ctx.originalHome;
    }

    if (ctx.originalSessionSecret === undefined) {
      delete process.env.OVERLEAF_SESSION_SECRET;
    } else {
      process.env.OVERLEAF_SESSION_SECRET = ctx.originalSessionSecret;
    }

    if (ctx.originalClaudeCodeHome === undefined) {
      delete process.env.CLAUDE_CODE_HOME;
    } else {
      process.env.CLAUDE_CODE_HOME = ctx.originalClaudeCodeHome;
    }
  });

  describe("createFileEditorLink", function () {
    it("returns a signed file-editor URL for Claude settings", async function (ctx) {
      ctx.req.params.Project_id = "project-123";
      ctx.req.body = { target: "claude-settings" };

      await ctx.controller.createFileEditorLink(ctx.req, ctx.res);

      expect(ctx.res.statusCode).to.equal(200);

      const body = JSON.parse(ctx.res.body);
      expect(body.success).to.equal(true);

      const url = new URL(body.url, "http://localhost");
      expect(url.pathname).to.equal("/file-editor/");
      expect(url.searchParams.get("path")).to.equal(
        "/home/node/.claude/settings.json",
      );

      const verification = ctx.verifyFileEditorToken(
        url.searchParams.get("token"),
      );
      expect(verification.valid).to.equal(true);
      expect(verification.payload.projectId).to.equal("project-123");
      expect(verification.payload.userId).to.equal("user-123");
      expect(verification.payload.target).to.equal("claude-settings");
      expect(verification.payload.editorHome).to.equal("/home/node");
    });

    it("rejects unknown file-editor targets", async function (ctx) {
      ctx.req.params.Project_id = "project-123";
      ctx.req.body = { target: "unknown-target" };

      await ctx.controller.createFileEditorLink(ctx.req, ctx.res);

      expect(ctx.res.statusCode).to.equal(400);
      expect(JSON.parse(ctx.res.body)).to.deep.equal({
        success: false,
        error: "invalid target",
      });
    });
  });
});
