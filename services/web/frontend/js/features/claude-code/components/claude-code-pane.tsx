import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import { useTranslation } from "react-i18next";
import { useClaudeCodeContext } from "../context/claude-code-context";
import { postJSON } from "@/infrastructure/fetch-json";
import { debugConsole } from "@/utils/debugging";
import { useProjectContext } from "@/shared/context/project-context";
import OLButton from "@/shared/components/ol/ol-button";
import { useModalsContext } from "@/features/ide-react/context/modals-context";
import { useEditorManagerContext } from "@/features/ide-react/context/editor-manager-context";
import MaterialIcon from "@/shared/components/material-icon";
import "xterm/css/xterm.css";

const TERMINAL_TITLE = "Terminal";

const TERMINAL_THEMES: Record<
  string,
  { background: string; foreground: string; cursor?: string }
> = {
  dark: { background: "#1e1e1e", foreground: "#d4d4d4" },
  "solarized-dark": {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
  },
  monokai: { background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0" },
  dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2" },
};

export default function ClaudeCodePane() {
  const { t } = useTranslation();
  const { projectId } = useProjectContext();
  const { socket, status, error, connect } = useClaudeCodeContext();
  const {
    genericModalVisible,
    genericMessageModalKind,
    hideGenericMessageModal,
  } = useModalsContext();
  const { setIgnoringExternalUpdates } = useEditorManagerContext();
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalMountRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [sessionCreated, setSessionCreated] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [themeName, setThemeName] = useState("dark");
  const [ignoreExternalUpdates, setIgnoreExternalUpdates] = useState(false);

  const isExternalUpdateModalVisible =
    genericModalVisible &&
    genericMessageModalKind === "document-updated-externally";

  const createSession = useCallback(async () => {
    if (!projectId || isCreatingSession || sessionCreated) {
      return;
    }

    setIsCreatingSession(true);
    try {
      const response = await postJSON(
        `/project/${projectId}/claude-code/session`,
      );
      if (response.success) {
        setSessionCreated(true);
        connect();
      }
    } catch (err) {
      debugConsole.error("Failed to create terminal session:", err);
    } finally {
      setIsCreatingSession(false);
    }
  }, [projectId, isCreatingSession, sessionCreated, connect]);

  const syncTerminalSize = useCallback(() => {
    const terminal = xtermRef.current;
    const fitAddon = fitAddonRef.current;

    if (!terminal || !fitAddon) {
      return;
    }

    fitAddon.fit();

    if (socket?.connected) {
      socket.emit("terminal-resize", {
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }
  }, [socket]);

  const openFileEditor = useCallback(
    async (target: "claude-settings" | "codex-auth") => {
      if (!projectId) {
        return;
      }

      const popup = window.open("about:blank", "_blank");
      if (popup) {
        popup.opener = null;
        popup.document.write(
          "<title>Opening file editor...</title><p>Opening file editor...</p>",
        );
      }

      try {
        const response = await postJSON<{
          success: boolean;
          url: string;
        }>(`/project/${projectId}/claude-code/file-editor-link`, {
          body: { target },
        });

        if (!response.url) {
          throw new Error("Missing file editor URL");
        }

        if (popup) {
          popup.location.replace(response.url);
        } else {
          window.open(response.url, "_self");
        }
      } catch (err) {
        popup?.close();
        debugConsole.error("Failed to open file editor:", err);
      }
    },
    [projectId],
  );

  // Auto-dismiss external update modal when toggle is enabled
  useEffect(() => {
    if (ignoreExternalUpdates && isExternalUpdateModalVisible) {
      hideGenericMessageModal();
    }
  }, [
    ignoreExternalUpdates,
    isExternalUpdateModalVisible,
    hideGenericMessageModal,
  ]);

  // Sync ignoring external updates state with editor manager
  useEffect(() => {
    setIgnoringExternalUpdates(ignoreExternalUpdates);
  }, [ignoreExternalUpdates, setIgnoringExternalUpdates]);

  // Apply font size changes to existing terminal
  useEffect(() => {
    const terminal = xtermRef.current;
    if (terminal) {
      terminal.options.fontSize = fontSize;
      fitAddonRef.current?.fit();
    }
  }, [fontSize]);

  // Apply theme changes to existing terminal
  useEffect(() => {
    const terminal = xtermRef.current;
    const theme = TERMINAL_THEMES[themeName] || TERMINAL_THEMES.dark;
    if (terminal) {
      terminal.options.theme = theme;
    }
  }, [themeName]);

  useEffect(() => {
    if (!terminalContainerRef.current || !terminalMountRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: TERMINAL_THEMES.dark,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(terminalMountRef.current);

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    requestAnimationFrame(() => {
      syncTerminalSize();
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        syncTerminalSize();
      });
    });

    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [syncTerminalSize]);

  useEffect(() => {
    if (!socket || !xtermRef.current) {
      return;
    }

    const terminal = xtermRef.current;

    const handleTerminalOutput = (data: string) => {
      terminal.write(data);
    };

    const handleSessionStarted = () => {
      syncTerminalSize();
    };

    const handleSessionError = ({ error: errorMsg }: { error: string }) => {
      terminal.writeln(`\r\n\x1b[31mError: ${errorMsg}\x1b[0m\r\n`);
    };

    socket.on("terminal-output", handleTerminalOutput);
    socket.on("session-started", handleSessionStarted);
    socket.on("session-error", handleSessionError);

    const startSession = () => {
      syncTerminalSize();
      socket.emit("start-session");
    };

    socket.on("connect", startSession);

    const disposable = terminal.onData((data) => {
      socket.emit("terminal-input", data);
    });

    if (socket.connected) {
      startSession();
    }

    return () => {
      socket.off("connect", startSession);
      socket.off("terminal-output", handleTerminalOutput);
      socket.off("session-started", handleSessionStarted);
      socket.off("session-error", handleSessionError);
      disposable.dispose();
    };
  }, [socket, syncTerminalSize]);

  useEffect(() => {
    createSession();
  }, [createSession]);

  return (
    <div className="ide-react-editor-sidebar claude-code-pane">
      <div className="claude-code-header">
        <h3>{TERMINAL_TITLE}</h3>
        <div className="claude-code-header-actions">
          <div className="claude-code-status">
            {status === "connecting" && <span>Connecting...</span>}
            {status === "connected" && (
              <span className="status-connected">Connected</span>
            )}
            {status === "disconnected" && <span>Disconnected</span>}
            {status === "error" && (
              <span className="status-error">Error: {error}</span>
            )}
          </div>
          {isExternalUpdateModalVisible && !ignoreExternalUpdates && (
            <OLButton
              variant="secondary"
              size="sm"
              onClick={hideGenericMessageModal}
              className="claude-code-dismiss-modal-button claude-code-dismiss-modal-button-floating"
            >
              {t("close_dialog")}
            </OLButton>
          )}
        </div>
      </div>
      <div className="claude-code-terminal-shell" ref={terminalContainerRef}>
        <div className="claude-code-terminal" ref={terminalMountRef} />
      </div>
      {/* Settings Panel */}
      <div className="claude-code-settings-panel">
        <button
          type="button"
          className="claude-code-settings-toggle"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <MaterialIcon
            type={settingsOpen ? "expand_more" : "chevron_right"}
            className="ide-rail-tab-link-icon"
          />
          <span>Settings</span>
        </button>
        {settingsOpen && (
          <div className="claude-code-settings-content">
            {/* Font Size */}
            <div className="claude-code-setting-row">
              <span className="claude-code-setting-label">Font Size</span>
              <div className="claude-code-setting-controls">
                <button
                  type="button"
                  className="claude-code-font-size-btn"
                  onClick={() => setFontSize((prev) => Math.max(8, prev - 1))}
                >
                  −
                </button>
                <span className="claude-code-font-size-value">{fontSize}</span>
                <button
                  type="button"
                  className="claude-code-font-size-btn"
                  onClick={() => setFontSize((prev) => Math.min(24, prev + 1))}
                >
                  +
                </button>
              </div>
            </div>
            {/* Theme */}
            <div className="claude-code-setting-row">
              <label htmlFor="claude-code-theme-select">Theme</label>
              <select
                id="claude-code-theme-select"
                className="claude-code-theme-select"
                value={themeName}
                onChange={(e) => setThemeName(e.target.value)}
              >
                <option value="dark">Dark</option>
                <option value="solarized-dark">Solarized Dark</option>
                <option value="monokai">Monokai</option>
                <option value="dracula">Dracula</option>
              </select>
            </div>
            {/* Ignore External Updates Toggle */}
            <div className="claude-code-setting-row">
              <label htmlFor="ignore-external-updates">
                Ignore external update alerts
              </label>
              <label
                className="claude-code-toggle-switch"
                htmlFor="ignore-external-updates"
                aria-label="Toggle ignore external update alerts"
              >
                <input
                  type="checkbox"
                  id="ignore-external-updates"
                  checked={ignoreExternalUpdates}
                  onChange={(e) => setIgnoreExternalUpdates(e.target.checked)}
                />
                <span className="claude-code-toggle-slider" />
              </label>
            </div>
            {/* Config file editor shortcuts */}
            <div className="claude-code-config-buttons">
              <button
                className="claude-code-config-btn"
                type="button"
                onClick={() => openFileEditor("claude-settings")}
              >
                <MaterialIcon
                  type="settings"
                  className="claude-code-config-btn-icon"
                />
                Claude Code Settings
              </button>
              <button
                className="claude-code-config-btn"
                type="button"
                onClick={() => openFileEditor("codex-auth")}
              >
                <MaterialIcon
                  type="key"
                  className="claude-code-config-btn-icon"
                />
                Codex Auth Config
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
