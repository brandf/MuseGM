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
 * Large images get a compression pass first (compress_image.py, PIL):
 * the Entry Hall map was 3.9 MB and may have hung Dave's scene switch,
 * so opaque images over 1 MB / 1600 px are resized and saved as JPEG
 * q82 (3.9 MB -> ~450 KB in testing) and transparent ones stay PNG.
 * The pass never fails the upload — on any error the original goes up.
 *
 * One constraint, found live: the target folder must already exist — the
 * server will NOT create nested folders ("Target directory ... does not
 * exist"). Upload to a folder that exists (the world folder always does);
 * a new subfolder has to be created once in the FilePicker by the GM.
 */
import { authenticateFoundry } from "../../vendor/foundryvtt-mcp/dist/foundry/auth.js";
import axios from "axios";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
  /** Present when the image was compressed before upload. */
  compressed?: { originalBytes: number; uploadedBytes: number; format: string };
}

/** Max bytes / pixels for a map image before the compression pass kicks in. */
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_DIMENSION = 1600;

interface CompressReport {
  changed: boolean;
  path: string;
  format: string | null;
  originalBytes: number;
  outputBytes: number;
  error: string | null;
}

/**
 * Run the PIL compression pass (src/worldbuilding/compress_image.py).
 * Returns the file to upload — the compressed copy when the pass ran, the
 * original otherwise. NEVER throws: if python3 / PIL is missing or the
 * pass fails for any reason, the original file is uploaded as-is.
 * The caller owns the returned tmp dir and must remove it after upload.
 */
function maybeCompressImage(filePath: string): { file: string; tmpDir: string | null; report: CompressReport | null } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-upload-"));
  try {
    const helper = path.join(import.meta.dir, "compress_image.py");
    const out = execFileSync(
      "python3",
      [
        helper,
        filePath,
        tmpDir,
        "--max-dimension",
        String(MAX_DIMENSION),
        "--max-bytes",
        String(MAX_UPLOAD_BYTES),
      ],
      { encoding: "utf-8", timeout: 30000 },
    );
    const report = JSON.parse(out) as CompressReport;
    if (report.error) {
      // The helper already copied the original to tmpDir on error; still
      // prefer the caller's original file — simplest correct fallback.
      return { file: filePath, tmpDir, report };
    }
    return { file: report.path, tmpDir, report };
  } catch {
    return { file: filePath, tmpDir, report: null };
  }
}

/**
 * Upload a local image file to the Foundry server's data folder.
 *
 * Large images get a compression pass first (PIL via compress_image.py):
 * opaque images over 1 MB / 1600 px become JPEG q82, transparent ones
 * stay PNG. The pass never fails the upload — on any error the original
 * file goes up as-is. The uploaded filename follows the compressed file
 * (e.g. `.png` -> `.jpg`); the returned `path` is what the server stored.
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
  const { file, tmpDir, report } = maybeCompressImage(filePath);
  try {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const filename = path.basename(file);

    const { session } = await authenticateFoundry(baseUrl, username, password);
    const data = fs.readFileSync(file);
    const fd = new FormData();
    fd.set("source", "data");
    fd.set("target", target);
    fd.set("upload", new Blob([data], { type: mime }), filename);
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
    const result: UploadResult = { path: body.path, url: `${baseUrl}/${body.path}` };
    if (report?.changed) {
      result.compressed = {
        originalBytes: report.originalBytes,
        uploadedBytes: report.outputBytes,
        format: report.format ?? "unknown",
      };
    }
    return result;
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
