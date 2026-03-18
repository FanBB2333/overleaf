/**
 * Lightweight file editor web service.
 * Provides a browser-based editor (Monaco) for editing config files
 * such as ~/.claude/settings.json and ~/.codex/auth.json.
 *
 * No external dependencies — uses only Node.js built-in modules.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { verifyFileEditorToken } = require("./token");

const PORT = parseInt(process.env.FILE_EDITOR_PORT || "3091", 10);
const HOST = "127.0.0.1";
const DEFAULT_EDITOR_HOME = "/home/node";

function getEditorHome() {
  return (
    process.env.CLAUDE_CODE_HOME || process.env.HOME || DEFAULT_EDITOR_HOME
  );
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function textResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const languageByExtension = {
    ".json": "json",
    ".js": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".py": "python",
    ".tex": "latex",
    ".css": "css",
    ".html": "html",
    ".xml": "xml",
    ".ini": "ini",
    ".conf": "ini",
    ".env": "shell",
  };

  return languageByExtension[ext] || "plaintext";
}

async function handleRead(res, url) {
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    return jsonResponse(res, 400, { error: "missing path" });
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return jsonResponse(res, 200, {
      content,
      language: getLanguage(filePath),
    });
  } catch (error) {
    return jsonResponse(res, error.code === "ENOENT" ? 404 : 500, {
      error: error.message,
    });
  }
}

async function handleWrite(req, res) {
  try {
    const { path: filePath, content } = await readBody(req);
    if (!filePath) {
      return jsonResponse(res, 400, { error: "missing path" });
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return jsonResponse(res, 200, { ok: true });
  } catch (error) {
    return jsonResponse(res, 500, { error: error.message });
  }
}

async function handleList(res, url, editorHome) {
  const dirPath = url.searchParams.get("path") || editorHome || getEditorHome();

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
      path: path.join(dirPath, entry.name),
    }));

    items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "dir" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    return jsonResponse(res, 200, { path: dirPath, items });
  } catch (error) {
    return jsonResponse(res, error.code === "ENOENT" ? 404 : 500, {
      error: error.message,
    });
  }
}

async function handleMkdir(req, res) {
  try {
    const { path: dirPath } = await readBody(req);
    if (!dirPath) {
      return jsonResponse(res, 400, { error: "missing path" });
    }

    fs.mkdirSync(dirPath, { recursive: true });
    return jsonResponse(res, 200, { ok: true });
  } catch (error) {
    return jsonResponse(res, 500, { error: error.message });
  }
}

function getTokenFromRequest(req, url) {
  const headerToken = req.headers["x-file-editor-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  return url.searchParams.get("token");
}

function isApiRoute(route) {
  return route.startsWith("/api/");
}

function ensureAuthorized(req, res, route, url) {
  const token = getTokenFromRequest(req, url);
  const verification = verifyFileEditorToken(token);

  if (verification.valid) {
    return { authorized: true, token, payload: verification.payload };
  }

  if (isApiRoute(route)) {
    jsonResponse(res, 401, { error: verification.error });
  } else {
    textResponse(res, 401, "Unauthorized");
  }

  return { authorized: false, token: null, payload: null };
}

function renderPageHtml({ token, editorHome }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>File Editor</title>
<style>
  :root {
    --bg: #1e1e1e; --sidebar-bg: #252526; --border: #3c3c3c;
    --text: #cccccc; --text-dim: #888; --accent: #0078d4;
    --hover: #2a2d2e; --success: #4caf50; --danger: #f44336;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  .topbar { display:flex; align-items:center; gap:8px; padding:6px 12px;
            background:var(--sidebar-bg); border-bottom:1px solid var(--border); flex-shrink:0; }
  .topbar h1 { font-size:14px; font-weight:600; margin-right:12px; white-space:nowrap; }
  .topbar input[type=text] { flex:1; padding:5px 10px; border:1px solid var(--border);
            border-radius:4px; background:#1e1e1e; color:var(--text); font-size:13px; }
  .topbar button { padding:5px 14px; border:none; border-radius:4px; cursor:pointer;
            font-size:13px; color:#fff; }
  .btn-open { background:var(--accent); }
  .btn-save { background:var(--success); }
  .btn-open:hover, .btn-save:hover { opacity:0.85; }
  .status { font-size:12px; color:var(--text-dim); white-space:nowrap; }
  .main { display:flex; flex:1; overflow:hidden; }
  .sidebar { width:260px; min-width:200px; background:var(--sidebar-bg);
             border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
  .sidebar-header { padding:8px 12px; font-size:12px; font-weight:600; text-transform:uppercase;
                    color:var(--text-dim); border-bottom:1px solid var(--border); display:flex;
                    align-items:center; justify-content:space-between; gap:8px; }
  .sidebar-header input { width:100%; min-width:0; padding:3px 6px; font-size:12px; border:1px solid var(--border);
                          border-radius:3px; background:var(--bg); color:var(--text); }
  .sidebar-header button { background:none; border:none; color:var(--accent); cursor:pointer; font-size:16px; }
  .tree { flex:1; overflow-y:auto; padding:4px 0; font-size:13px; }
  .tree-item { display:flex; align-items:center; padding:3px 8px; cursor:pointer; white-space:nowrap;
               text-overflow:ellipsis; overflow:hidden; }
  .tree-item:hover { background:var(--hover); }
  .tree-icon { width:18px; text-align:center; margin-right:4px; flex-shrink:0; font-size:12px; }
  .tree-name { overflow:hidden; text-overflow:ellipsis; }
  .breadcrumb { padding:4px 10px; font-size:12px; color:var(--text-dim); border-bottom:1px solid var(--border);
                word-break:break-all; }
  .breadcrumb span { cursor:pointer; color:var(--accent); }
  .breadcrumb span:hover { text-decoration:underline; }
  .editor-wrap { flex:1; display:flex; flex-direction:column; overflow:hidden; }
  #editor-container { flex:1; }
  .quick-bar { padding:4px 12px; display:flex; gap:6px; flex-wrap:wrap; border-bottom:1px solid var(--border);
               background:var(--sidebar-bg); }
  .chip { padding:3px 10px; border-radius:12px; font-size:11px; cursor:pointer;
          background:var(--border); color:var(--text); border:none; }
  .chip:hover { background:var(--accent); color:#fff; }
</style>
</head>
<body>

<div class="topbar">
  <h1>File Editor</h1>
  <input type="text" id="pathInput" placeholder="Enter file path" spellcheck="false"/>
  <button class="btn-open" onclick="openFile()">Open</button>
  <button class="btn-save" onclick="saveFile()">Save</button>
  <span class="status" id="status"></span>
</div>

<div class="quick-bar">
  <button class="chip" onclick="quickOpen(QUICK_PATHS.claudeSettings)">Claude settings</button>
  <button class="chip" onclick="quickOpen(QUICK_PATHS.codexAuth)">Codex auth</button>
  <button class="chip" onclick="quickOpen(QUICK_PATHS.overleafSettings)">Overleaf settings</button>
  <button class="chip" onclick="quickOpen(QUICK_PATHS.shellRc)">Shell rc</button>
</div>

<div class="main">
  <div class="sidebar">
    <div class="sidebar-header">
      <span>Explorer</span>
      <input id="browseInput" placeholder="${editorHome}" spellcheck="false"
             onkeydown="if (event.key === 'Enter') browseTo(this.value)"/>
      <button onclick="browseTo(document.getElementById('browseInput').value)" title="Go">&#8629;</button>
    </div>
    <div class="breadcrumb" id="breadcrumb"></div>
    <div class="tree" id="tree"></div>
  </div>
  <div class="editor-wrap">
    <div id="editor-container"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
<script>
const AUTH_TOKEN = ${JSON.stringify(token)}
const USER_HOME = ${JSON.stringify(editorHome)}
const QUICK_PATHS = {
  claudeSettings: USER_HOME + '/.claude/settings.json',
  codexAuth: USER_HOME + '/.codex/auth.json',
  overleafSettings: '/etc/overleaf/settings.js',
  shellRc: USER_HOME + '/.bashrc',
}
const BASE = window.location.pathname.replace(/\\/$/, '') || '/file-editor'

let editor = null
let currentDir = USER_HOME

function buildUrl(route, params) {
  const url = new URL(BASE + route, window.location.origin)
  const searchParams = params || {}
  for (const [key, value] of Object.entries(searchParams)) {
    if (value != null && value !== '') {
      url.searchParams.set(key, value)
    }
  }
  url.searchParams.set('token', AUTH_TOKEN)
  return url.toString()
}

async function api(route, options, params) {
  const response = await fetch(buildUrl(route, params), options)
  return response.json()
}

function setStatus(message, ok) {
  const element = document.getElementById('status')
  element.textContent = message
  element.style.color = ok ? '#4caf50' : (ok === false ? '#f44336' : '#888')
  if (ok !== undefined) {
    setTimeout(() => {
      element.textContent = ''
    }, 3000)
  }
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeJsString(value) {
  return value
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/\\r/g, '\\\\r')
    .replace(/\\n/g, '\\\\n')
}

async function openFile(filePath) {
  const targetPath = filePath || document.getElementById('pathInput').value.trim()
  if (!targetPath || !editor) {
    return
  }

  document.getElementById('pathInput').value = targetPath
  setStatus('Opening...')

  const data = await api('/api/read', undefined, { path: targetPath })
  if (data.error) {
    setStatus(data.error, false)
    return
  }

  const model = editor.getModel()
  monaco.editor.setModelLanguage(model, data.language || 'plaintext')
  editor.setValue(data.content)
  setStatus('Opened ' + targetPath, true)
}

async function saveFile() {
  if (!editor) {
    return
  }

  const targetPath = document.getElementById('pathInput').value.trim()
  if (!targetPath) {
    setStatus('No file path specified', false)
    return
  }

  setStatus('Saving...')
  const data = await api('/api/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: targetPath, content: editor.getValue() }),
  })

  if (data.error) {
    setStatus('Error: ' + data.error, false)
    return
  }

  setStatus('Saved ' + targetPath, true)
}

function quickOpen(filePath) {
  document.getElementById('pathInput').value = filePath
  openFile(filePath)
}

async function browseTo(dir) {
  const nextDir = dir || USER_HOME
  currentDir = nextDir
  document.getElementById('browseInput').value = nextDir

  const data = await api('/api/list', undefined, { path: nextDir })
  if (data.error) {
    setStatus(data.error, false)
    return
  }

  renderBreadcrumb(nextDir)
  renderTree(data.items)
}

function renderBreadcrumb(dir) {
  const parts = dir.split('/').filter(Boolean)
  const items = ['<span onclick="browseTo(\\'/\\')">/</span>']
  let accumulator = ''

  for (const part of parts) {
    accumulator += '/' + part
    items.push(
      '<span onclick="browseTo(\\'' +
        escapeJsString(accumulator) +
        '\\')">' +
        escapeHtml(part) +
        '</span>'
    )
  }

  document.getElementById('breadcrumb').innerHTML = items.join(' / ')
}

function renderTree(items) {
  const element = document.getElementById('tree')
  if (!items.length) {
    element.innerHTML = '<div style="padding:8px 12px;color:#666">Empty directory</div>'
    return
  }

  const parentDir = currentDir === '/' ? '/' : currentDir.replace(/\\/[^\\/]+$/, '') || '/'
  let html =
    '<div class="tree-item" onclick="browseTo(\\'' +
    escapeJsString(parentDir) +
    '\\')">' +
    '<span class="tree-icon">&#8592;</span><span class="tree-name">..</span></div>'

  for (const item of items) {
    if (item.type === 'dir') {
      html +=
        '<div class="tree-item" onclick="browseTo(\\'' +
        escapeJsString(item.path) +
        '\\')">' +
        '<span class="tree-icon">&#128193;</span><span class="tree-name">' +
        escapeHtml(item.name) +
        '</span></div>'
    } else {
      html +=
        '<div class="tree-item" onclick="quickOpen(\\'' +
        escapeJsString(item.path) +
        '\\')">' +
        '<span class="tree-icon">&#128196;</span><span class="tree-name">' +
        escapeHtml(item.name) +
        '</span></div>'
    }
  }

  element.innerHTML = html
}

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } })
require(['vs/editor/editor.main'], function () {
  monaco.editor.defineTheme('dark-custom', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#1e1e1e' },
  })

  editor = monaco.editor.create(document.getElementById('editor-container'), {
    value: '// Open a file to start editing\\n// Use the sidebar, path input, or quick-access buttons above.',
    language: 'plaintext',
    theme: 'dark-custom',
    fontSize: 14,
    minimap: { enabled: false },
    automaticLayout: true,
    wordWrap: 'on',
    tabSize: 2,
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile)

  browseTo(USER_HOME)

  const params = new URLSearchParams(window.location.search)
  const autoPath = params.get('path')
  if (autoPath) {
    quickOpen(autoPath)
  }
})
</script>
</body>
</html>`;
}

function createRequestListener() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const route = url.pathname.replace(/^\/file-editor/, "") || "/";

    const auth = ensureAuthorized(req, res, route, url);
    if (!auth.authorized) {
      return;
    }

    try {
      if (req.method === "GET" && (route === "/" || route === "")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderPageHtml({
            token: getTokenFromRequest(req, url),
            editorHome: auth.payload?.editorHome || getEditorHome(),
          }),
        );
        return;
      }

      if (req.method === "GET" && route === "/api/read") {
        await handleRead(res, url);
        return;
      }

      if (req.method === "GET" && route === "/api/list") {
        await handleList(res, url, auth.payload?.editorHome);
        return;
      }

      if (req.method === "POST" && route === "/api/write") {
        await handleWrite(req, res);
        return;
      }

      if (req.method === "POST" && route === "/api/mkdir") {
        await handleMkdir(req, res);
        return;
      }

      textResponse(res, 404, "Not found");
    } catch (error) {
      console.error(error);
      jsonResponse(res, 500, { error: error.message });
    }
  };
}

function createFileEditorServer() {
  return http.createServer(createRequestListener());
}

if (require.main === module) {
  const server = createFileEditorServer();
  server.listen(PORT, HOST, () => {
    console.log(`File editor listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  createFileEditorServer,
  createRequestListener,
  getEditorHome,
};
