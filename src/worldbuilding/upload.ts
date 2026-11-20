/**
 * Image upload (the gap the upstream MCP leaves open).
 *
 * The MCP has no upload tool, but Foundry itself has one: the FilePicker
 * posts a multipart form to POST `<base>/upload` with fields
 *   source: "data" (the server's user-data folder)
 *   target: destination folder, e.g. "worlds/testbed/maps"
 *   upload: the file
 * and it needs the authenticated session cookie + an Origin header (the
 * same CSRF check that broke POST /join on 14.370).
 *
 * This module reuses the vendored client's own login flow
 * (authenticateFoundry) to get a session, then posts the file. The
 * returned `path` is the server-relative path to use as a scene
 * `background.src` (e.g. "worlds/testbed/maps/meroki-test-map.png").
 *
 * Verified live Nov 19 against TestBed: a 400x300 PNG uploaded to
 * worlds/testbed/ and GETs back byte-identical at the returned path.
 *
 * One constraint, found live: the target folder must already exist — the
 * server will NOT create nested folders ("Target directory ... does not
 * exist"). Upload to a folder that exists (the world folder always does);
 * a new subfolder has to be created once in the FilePicker by the GM.
 */
import { authenticateFoundry } from "../../vendor/foundryvtt-mcp/dist/foundry/auth.js";
import axios from "axios";
import * as fs from "node:fs";
import * as path from "node:path";

export interface UploadConfig {
  url?: string;
  username?: string;
  password?: string;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export interface UploadResult {
  /** Server-relative path, e.g. "worlds/testbed/maps/dungeon.png". */
  path: string;
  /** Full URL where the file can be fetched. */
  url: string;
}

/**
 * Upload a local image file to the Foundry server's data folder.
 *
 * @param filePath local file to upload
 * @param target destination folder on the server, e.g. "worlds/testbed/maps"
 * @param config connection config (env defaults)
 */
export async function uploadImage(
  filePath: string,
  target: string,
  config: UploadConfig = {},
): Promise<UploadResult> {
  const baseUrl = (config.url ?? process.env.FOUNDRY_URL ?? "").replace(/\/$/, "");
  const username = config.username ?? process.env.FOUNDRY_USERNAME;
  const password = config.password ?? process.env.FOUNDRY_PASSWORD;
  if (!baseUrl || !username || !password) {
    throw new Error("Missing Foundry credentials (FOUNDRY_URL / FOUNDRY_USERNAME / FOUNDRY_PASSWORD).");
  }
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const filename = path.basename(filePath);

  const { session } = await authenticateFoundry(baseUrl, username, password);
  const file = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.set("source", "data");
  fd.set("target", target);
  fd.set("upload", new Blob([file], { type: mime }), filename);
  const res = await axios.post(`${baseUrl}/upload`, fd, {
    headers: { Cookie: `session=${session}`, Origin: baseUrl },
    maxRedirects: 0,
    validateStatus: () => true,
  });
  const body = res.data as { path?: string; error?: string; message?: string };
  if (res.status !== 200 || !body?.path) {
    throw new Error(
      `Upload failed (HTTP ${res.status}): ${body?.error ?? body?.message ?? JSON.stringify(body)?.slice(0, 200)}`,
    );
  }
  return { path: body.path, url: `${baseUrl}/${body.path}` };
}
