import { timingSafeEqual } from "node:crypto";
import { put } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";

const USER_CODE = "3032582018";
const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024;

function secretMatches(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function readBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function parseClientPayload(value) {
  if (!value) throw new Error("試合データがありません。");

  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("試合データがJSONではありません。");
  }

  if (payload.userCode !== USER_CODE) {
    throw new Error("User Codeが一致しません。");
  }

  return {
    userCode: USER_CODE,
    playerName: String(payload.playerName || "おばけたろう").slice(0, 100),
    matchKey: String(payload.matchKey || "").slice(0, 128),
    detectedAt: String(payload.detectedAt || new Date().toISOString()).slice(0, 64),
    match: payload.match && typeof payload.match === "object" ? payload.match : {},
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.RECORDER_API_KEY),
      userCode: USER_CODE,
      maxVideoSizeBytes: MAX_VIDEO_SIZE,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!process.env.RECORDER_API_KEY) {
    return res.status(503).json({ ok: false, error: "RECORDER_API_KEY is not configured." });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!secretMatches(readBearerToken(req), process.env.RECORDER_API_KEY)) {
          throw new Error("Unauthorized");
        }

        if (!pathname.startsWith(`sf6/videos/${USER_CODE}/`)) {
          throw new Error("Upload path is not allowed.");
        }

        const metadata = parseClientPayload(clientPayload);
        return {
          allowedContentTypes: [
            "video/mp4",
            "video/x-matroska",
            "video/webm",
            "video/quicktime",
            "application/octet-stream",
          ],
          maximumSizeInBytes: MAX_VIDEO_SIZE,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify(metadata),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const metadata = parseClientPayload(tokenPayload);
        const createdAt = new Date().toISOString();
        const safeDate = createdAt.replace(/[:.]/g, "-");
        const metadataPath = `sf6/matches/${USER_CODE}/${safeDate}-${metadata.matchKey || "match"}.json`;

        await put(
          metadataPath,
          JSON.stringify(
            {
              ...metadata,
              createdAt,
              video: {
                url: blob.url,
                downloadUrl: blob.downloadUrl,
                pathname: blob.pathname,
                contentType: blob.contentType,
                contentDisposition: blob.contentDisposition,
              },
            },
            null,
            2,
          ),
          {
            access: "public",
            contentType: "application/json; charset=utf-8",
            addRandomSuffix: true,
          },
        );
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
