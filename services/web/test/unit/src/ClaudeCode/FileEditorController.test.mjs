import fs from "node:fs/promises";
import os from "node:os";
import Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockRequest from "../helpers/MockRequest.mjs";
import MockResponse from "../helpers/MockResponse.mjs";

const controllerModulePath =
  "../../../../app/src/Features/ClaudeCode/FileEditorController.mjs";
const tokenModulePath =
  "../../../../app/src/Features/ClaudeCode/fileEditorToken.mjs";

describe("FileEditorController", function () {
  beforeEach(async function (ctx) {
    ctx.originalSessionSecret = process.env.OVERLEAF_SESSION_SECRET;
    process.env.OVERLEAF_SESSION_SECRET = "test-file-editor-secret";
    ctx.tempDir = await fs.mkdtemp(
      Path.join(os.tmpdir(), "claude-file-editor-test-"),
    );

    const tokenModule = await import(tokenModulePath);
    ctx.createFileEditorToken = tokenModule.createFileEditorToken;
    ctx.controller = (await import(controllerModulePath)).default;
  });

  afterEach(async function (ctx) {
    if (ctx.originalSessionSecret === undefined) {
      delete process.env.OVERLEAF_SESSION_SECRET;
    } else {
      process.env.OVERLEAF_SESSION_SECRET = ctx.originalSessionSecret;
    }

    await fs.rm(ctx.tempDir, { recursive: true, force: true });
  });

  function buildToken(
    createFileEditorToken,
    tempDir,
    target = "claude-settings",
  ) {
    return createFileEditorToken({
      projectId: "project-123",
      userId: "user-123",
      target,
      editorHome: tempDir,
    });
  }

  it("renders the editor page for a valid token", async function (ctx) {
    const req = new MockRequest(vi);
    const res = new MockResponse(vi);
    const filePath = Path.join(ctx.tempDir, ".claude", "settings.json");

    req.query = {
      path: filePath,
      token: buildToken(ctx.createFileEditorToken, ctx.tempDir),
    };
    req.path = "/file-editor/";

    await ctx.controller.renderPage(req, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.contain("File Editor");
    expect(res.body).to.contain(filePath);
  });

  it("reads the authorized file path", async function (ctx) {
    const req = new MockRequest(vi);
    const res = new MockResponse(vi);
    const filePath = Path.join(ctx.tempDir, ".claude", "settings.json");

    await fs.mkdir(Path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{"theme":"dark"}\n', "utf8");

    req.query = {
      path: filePath,
      token: buildToken(ctx.createFileEditorToken, ctx.tempDir),
    };
    req.path = "/file-editor/api/read";

    await ctx.controller.readFile(req, res);

    expect(res.statusCode).to.equal(200);
    expect(JSON.parse(res.body)).to.deep.equal({
      content: '{"theme":"dark"}\n',
      language: "json",
      path: filePath,
    });
  });

  it("writes the authorized file path", async function (ctx) {
    const req = new MockRequest(vi);
    const res = new MockResponse(vi);
    const filePath = Path.join(ctx.tempDir, ".claude", "settings.json");

    req.body = {
      path: filePath,
      content: '{"theme":"light"}\n',
    };
    req.query = {
      token: buildToken(ctx.createFileEditorToken, ctx.tempDir),
    };
    req.path = "/file-editor/api/write";
    req.method = "POST";

    await ctx.controller.writeFile(req, res);

    expect(res.statusCode).to.equal(200);
    expect(JSON.parse(res.body)).to.deep.equal({
      ok: true,
      path: filePath,
    });
    expect(await fs.readFile(filePath, "utf8")).to.equal('{"theme":"light"}\n');
  });

  it("rejects writes outside the token-authorized path", async function (ctx) {
    const req = new MockRequest(vi);
    const res = new MockResponse(vi);

    req.body = {
      path: Path.join(ctx.tempDir, ".codex", "auth.json"),
      content: "{}\n",
    };
    req.query = {
      token: buildToken(ctx.createFileEditorToken, ctx.tempDir),
    };
    req.path = "/file-editor/api/write";
    req.method = "POST";

    await ctx.controller.writeFile(req, res);

    expect(res.statusCode).to.equal(403);
    expect(JSON.parse(res.body)).to.deep.equal({
      error: "invalid path",
    });
  });
});
