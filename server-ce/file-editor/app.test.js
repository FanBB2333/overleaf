const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.OVERLEAF_SESSION_SECRET = "test-file-editor-secret";

const { createFileEditorServer } = require("./app");
const { createFileEditorToken } = require("./token");

test("file editor requires a signed token for API routes", async () => {
  const server = createFileEditorServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/list?path=${encodeURIComponent("/tmp")}`,
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "missing token" });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("file editor serves the HTML page for valid signed URLs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-editor-test-"));
  const token = createFileEditorToken({
    projectId: "project-123",
    userId: "user-123",
    editorHome: tempDir,
  });
  const server = createFileEditorServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const response = await fetch(
      `http://127.0.0.1:${port}/file-editor/?token=${encodeURIComponent(token)}`,
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /File Editor/);
    assert.match(
      body,
      new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("file editor supports proxied /file-editor API prefixes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-editor-test-"));
  const filePath = path.join(tempDir, "settings.json");
  const fileContent = '{"ok":true}\n';
  const token = createFileEditorToken({
    projectId: "project-123",
    userId: "user-123",
    editorHome: tempDir,
  });
  const server = createFileEditorServer();

  await fs.writeFile(filePath, fileContent, "utf8");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/file-editor/api/list?token=${encodeURIComponent(token)}`,
    );
    assert.equal(listResponse.status, 200);

    const listBody = await listResponse.json();
    assert.equal(listBody.path, tempDir);
    assert.deepEqual(listBody.items, [
      {
        name: "settings.json",
        type: "file",
        path: filePath,
      },
    ]);

    const readResponse = await fetch(
      `http://127.0.0.1:${port}/file-editor/api/read?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`,
    );
    assert.equal(readResponse.status, 200);
    assert.deepEqual(await readResponse.json(), {
      content: fileContent,
      language: "json",
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
