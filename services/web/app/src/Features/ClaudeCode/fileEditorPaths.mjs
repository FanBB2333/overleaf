import path from "node:path";

const DEFAULT_TERMINAL_HOME = "/home/node";

function getClaudeCodeHome() {
  return (
    process.env.CLAUDE_CODE_HOME || process.env.HOME || DEFAULT_TERMINAL_HOME
  );
}

function resolveFileEditorPath(target, editorHome = getClaudeCodeHome()) {
  switch (target) {
    case "claude-settings":
      return path.join(editorHome, ".claude", "settings.json");
    case "codex-auth":
      return path.join(editorHome, ".codex", "auth.json");
    default:
      return null;
  }
}

export { DEFAULT_TERMINAL_HOME, getClaudeCodeHome, resolveFileEditorPath };
