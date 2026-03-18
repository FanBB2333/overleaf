import fs from "node:fs/promises";
import path from "node:path";
import {
  getClaudeCodeHome,
  resolveFileEditorPath,
} from "./fileEditorPaths.mjs";
import { verifyFileEditorToken } from "./fileEditorToken.mjs";

function getFileEditorToken(req) {
  const headerToken = req.headers["x-file-editor-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  return req.query?.token;
}

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const languageByExtension = {
    ".bash": "shell",
    ".conf": "ini",
    ".css": "css",
    ".env": "shell",
    ".html": "html",
    ".ini": "ini",
    ".js": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".mjs": "javascript",
    ".py": "python",
    ".sh": "shell",
    ".tex": "latex",
    ".toml": "toml",
    ".ts": "typescript",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zsh": "shell",
  };

  return languageByExtension[ext] || "plaintext";
}

function authorizeRequest(req, res) {
  const verification = verifyFileEditorToken(getFileEditorToken(req));

  if (verification.valid) {
    return verification.payload;
  }

  if (req.path?.startsWith("/file-editor/api/")) {
    res.status(401).json({ error: verification.error });
  } else {
    res.status(401).send("Unauthorized");
  }

  return null;
}

function getAuthorizedPath(payload) {
  return resolveFileEditorPath(
    payload.target,
    payload.editorHome || getClaudeCodeHome(),
  );
}

function validateRequestedPath(req, res, payload) {
  const allowedPath = getAuthorizedPath(payload);
  const requestedPath = req.method === "GET" ? req.query?.path : req.body?.path;

  if (!allowedPath) {
    res.status(400).json({ error: "invalid target" });
    return null;
  }

  if (requestedPath && requestedPath !== allowedPath) {
    res.status(403).json({ error: "invalid path" });
    return null;
  }

  return allowedPath;
}

function renderPageHtml({ filePath, token }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>File Editor</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #17191d;
    --panel: #1f2329;
    --border: #323843;
    --text: #e8ecf1;
    --muted: #98a2b3;
    --accent: #4c8bf5;
    --success: #1e9d63;
    --danger: #d14343;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: linear-gradient(180deg, #13151a 0%, var(--bg) 100%);
    color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .shell {
    max-width: 1120px;
    margin: 0 auto;
    padding: 24px;
  }
  .panel {
    border: 1px solid var(--border);
    background: var(--panel);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  }
  .header {
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }
  .path {
    margin-top: 6px;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-all;
  }
  .toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }
  .status {
    color: var(--muted);
    min-height: 21px;
  }
  .status.ok { color: #7ce2b1; }
  .status.error { color: #ff8f8f; }
  button {
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: white;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 9px 14px;
  }
  button:hover { filter: brightness(1.08); }
  textarea {
    display: block;
    width: 100%;
    min-height: calc(100vh - 220px);
    resize: vertical;
    border: 0;
    outline: 0;
    margin: 0;
    padding: 18px 20px 20px;
    background: #12151b;
    color: var(--text);
    font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
</style>
</head>
<body>
  <div class="shell">
    <div class="panel">
      <div class="header">
        <h1 class="title">File Editor</h1>
        <div class="path">${filePath}</div>
      </div>
      <div class="toolbar">
        <div class="status" id="status">Loading...</div>
        <button type="button" id="saveButton">Save</button>
      </div>
      <textarea id="editor" spellcheck="false"></textarea>
    </div>
  </div>
  <script>
    const token = ${JSON.stringify(token)};
    const filePath = ${JSON.stringify(filePath)};
    const basePath = window.location.pathname.replace(/\\/$/, "") || "/file-editor";
    const statusElement = document.getElementById("status");
    const editorElement = document.getElementById("editor");
    const saveButton = document.getElementById("saveButton");

    function setStatus(message, kind) {
      statusElement.textContent = message;
      statusElement.className = "status" + (kind ? " " + kind : "");
    }

    function buildUrl(route) {
      const url = new URL(basePath + route, window.location.origin);
      url.searchParams.set("path", filePath);
      url.searchParams.set("token", token);
      return url.toString();
    }

    async function loadFile() {
      setStatus("Loading...");
      const response = await fetch(buildUrl("/api/read"));
      const data = await response.json();

      if (!response.ok) {
        setStatus(data.error || "Failed to load file", "error");
        return;
      }

      editorElement.value = data.content || "";
      setStatus("Ready", "ok");
    }

    async function saveFile() {
      saveButton.disabled = true;
      setStatus("Saving...");

      try {
        const response = await fetch(buildUrl("/api/write"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: filePath,
            content: editorElement.value,
          }),
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to save file");
        }

        setStatus("Saved", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        saveButton.disabled = false;
      }
    }

    saveButton.addEventListener("click", saveFile);
    window.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        saveFile();
      }
    });

    loadFile();
  </script>
</body>
</html>`;
}

export default {
  async renderPage(req, res) {
    const payload = authorizeRequest(req, res);
    if (!payload) {
      return;
    }

    const filePath = validateRequestedPath(req, res, payload);
    if (!filePath) {
      return;
    }

    res.type("html").send(
      renderPageHtml({
        filePath,
        token: getFileEditorToken(req),
      }),
    );
  },

  async readFile(req, res) {
    const payload = authorizeRequest(req, res);
    if (!payload) {
      return;
    }

    const filePath = validateRequestedPath(req, res, payload);
    if (!filePath) {
      return;
    }

    try {
      const content = await fs.readFile(filePath, "utf8");
      res.json({
        content,
        language: getLanguage(filePath),
        path: filePath,
      });
    } catch (error) {
      res.status(error.code === "ENOENT" ? 404 : 500).json({
        error: error.message,
      });
    }
  },

  async writeFile(req, res) {
    const payload = authorizeRequest(req, res);
    if (!payload) {
      return;
    }

    const filePath = validateRequestedPath(req, res, payload);
    if (!filePath) {
      return;
    }

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, req.body?.content || "", "utf8");
      res.json({ ok: true, path: filePath });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
};
