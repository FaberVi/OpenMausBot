import {
  extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, parseAudioRange, readAttachment, saveFile, saveImageUpload,
  validateAttachmentUploadId, type SavedAttachment,
} from "../attachments.ts";
import type { RouteContext } from "./table.ts";

/** POST /api/attachments, POST /api/files, GET /api/attachments/:name. */
export async function handleThreadUploadRoutes(
  { req, res, url, path, method, json }: RouteContext,
): Promise<boolean> {
  if (method === "POST" && path === "/api/attachments") {
    let uploadId: string | undefined;
    try {
      uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
    } catch (error) {
      req.resume();
      throw error;
    }
    const rawType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"];
    const mime = rawType?.split(";")[0]?.trim().toLowerCase();
    if (!mime || !extensionForMime(mime)) {
      json(res, 400, { error: "content-type must be an image type" });
      return true;
    }
    const rawLength = Array.isArray(req.headers["content-length"])
      ? req.headers["content-length"][0]
      : req.headers["content-length"];
    const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
    if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      req.resume();
      json(res, 400, { error: "content-length must be a non-negative integer" });
      return true;
    }
    if (declaredLength !== undefined && declaredLength > IMAGE_MAX_BYTES) {
      req.resume();
      json(res, 413, { error: `image exceeds ${IMAGE_MAX_BYTES} bytes` });
      return true;
    }
    const saved = await new Promise<SavedAttachment>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const fail = (status: number, msg: string) => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error(msg), { status }));
      };
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        received += chunk.byteLength;
        if (received > IMAGE_MAX_BYTES) return fail(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
        chunks.push(chunk);
      });
      req.on("end", async () => {
        if (settled) return;
        settled = true;
        try {
          resolve(await saveImageUpload(Buffer.concat(chunks), mime, uploadId));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
    });
    json(res, 201, saved);
    return true;
  }

  if (method === "POST" && path === "/api/files") {
    let uploadId: string | undefined;
    try {
      uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
    } catch (error) {
      req.resume();
      throw error;
    }
    const name = url.searchParams.get("name");
    if (!name) {
      req.resume();
      json(res, 400, { error: "name is required" });
      return true;
    }
    const rawType = Array.isArray(req.headers["content-type"])
      ? req.headers["content-type"][0]
      : req.headers["content-type"];
    const rawLength = Array.isArray(req.headers["content-length"])
      ? req.headers["content-length"][0]
      : req.headers["content-length"];
    const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
    if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      req.resume();
      json(res, 400, { error: "content-length must be a non-negative integer" });
      return true;
    }
    if (declaredLength !== undefined && declaredLength > FILE_MAX_BYTES) {
      req.resume();
      json(res, 413, { error: `file exceeds ${FILE_MAX_BYTES} bytes` });
      return true;
    }
    try {
      const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
      const saved = await saveFile(chunks, name, rawType ?? "", { uploadId, expectedBytes: declaredLength });
      json(res, 201, saved);
      return true;
    } catch (error) {
      req.resume();
      throw error;
    }
  }

  const m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
  if (m && method === "GET") {
    const attachment = readAttachment(m[1]!);
    if (!attachment) {
      json(res, 404, { error: "no such attachment" });
      return true;
    }
    const size = attachment.bytes.byteLength;
    const headers = {
      "content-type": attachment.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (attachment.mime.startsWith("audio/")) {
      const rawRange = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
      const range = parseAudioRange(rawRange, size);
      if (range.kind === "unsatisfiable") {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
        res.end();
        return true;
      }
      if (range.kind === "range") {
        res.writeHead(206, {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
        });
        res.end(attachment.bytes.subarray(range.start, range.end + 1));
        return true;
      }
    }
    res.writeHead(200, { ...headers, "content-length": String(size) });
    res.end(attachment.bytes);
    return true;
  }

  return false;
}
