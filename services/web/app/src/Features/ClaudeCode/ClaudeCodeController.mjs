import ClaudeCodeService from "./ClaudeCodeService.mjs";
import SessionManager from "../Authentication/SessionManager.mjs";
import logger from "@overleaf/logger";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildFileEditorUrl,
  createFileEditorToken,
} = require("../../../../../../server-ce/file-editor/token.js");

const DEFAULT_TERMINAL_HOME = "/home/node";

function getClaudeCodeHome() {
  return (
    process.env.CLAUDE_CODE_HOME || process.env.HOME || DEFAULT_TERMINAL_HOME
  );
}

function resolveFileEditorPath(target) {
  const editorHome = getClaudeCodeHome();

  switch (target) {
    case "claude-settings":
      return path.join(editorHome, ".claude", "settings.json");
    case "codex-auth":
      return path.join(editorHome, ".codex", "auth.json");
    default:
      return null;
  }
}

export default {
  async createSession(req, res) {
    const projectId = req.params.Project_id;
    const userId = SessionManager.getLoggedInUserId(req.session);

    try {
      const session = await ClaudeCodeService.createSession(projectId, userId);
      res.json({
        success: true,
        workDir: session.workDir,
      });
    } catch (error) {
      logger.error(
        { projectId, userId, error },
        "Failed to create Claude Code session",
      );
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },

  async destroySession(req, res) {
    const projectId = req.params.Project_id;

    try {
      await ClaudeCodeService.destroySession(projectId);
      res.json({ success: true });
    } catch (error) {
      logger.error(
        { projectId, error },
        "Failed to destroy Claude Code session",
      );
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },

  async getStatus(req, res) {
    const projectId = req.params.Project_id;
    const session = ClaudeCodeService.getSession(projectId);

    res.json({
      active: !!session,
      connections: session ? session.connections.size : 0,
    });
  },

  async createFileEditorLink(req, res) {
    const projectId = req.params.Project_id;
    const userId = SessionManager.getLoggedInUserId(req.session);
    const target = req.body?.target;
    const filePath = resolveFileEditorPath(target);

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: "invalid target",
      });
    }

    try {
      const editorHome = getClaudeCodeHome();
      const token = createFileEditorToken({
        projectId,
        userId,
        target,
        editorHome,
      });

      return res.json({
        success: true,
        url: buildFileEditorUrl({
          path: filePath,
          token,
        }),
      });
    } catch (error) {
      logger.error(
        { projectId, userId, target, error },
        "Failed to create file editor link",
      );
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
};
