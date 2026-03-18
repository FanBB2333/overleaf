import crypto from "node:crypto";

const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FILE_EDITOR_SECRET = "overleaf-file-editor-dev-secret";

function getFileEditorSecret() {
  return (
    process.env.FILE_EDITOR_SECRET ||
    process.env.OVERLEAF_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.CRYPTO_RANDOM ||
    DEFAULT_FILE_EDITOR_SECRET
  );
}

function createFileEditorToken(
  payload = {},
  { expiresInMs = DEFAULT_TOKEN_TTL_MS } = {},
) {
  const now = Date.now();
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...payload,
      scope: "file-editor",
      iat: now,
      exp: now + expiresInMs,
    }),
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", getFileEditorSecret())
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function buildFileEditorUrl({ path, token, basePath = "/file-editor/" }) {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }
  params.set("token", token);
  return `${basePath}?${params.toString()}`;
}

export {
  DEFAULT_TOKEN_TTL_MS,
  buildFileEditorUrl,
  createFileEditorToken,
  getFileEditorSecret,
};
