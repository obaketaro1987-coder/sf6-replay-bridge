import { list } from "@vercel/blob";

const USER_CODE = "3032582018";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    return res.status(503).json({
      ok: false,
      configured: false,
      userCode: USER_CODE,
      matches: [],
      error: "Vercel Blob is not configured yet.",
    });
  }

  try {
    const result = await list({
      prefix: `sf6/matches/${USER_CODE}/`,
      limit: 100,
    });

    const metadataBlobs = [...result.blobs]
      .filter((blob) => blob.pathname.endsWith(".json"))
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
      .slice(0, 30);

    const matches = await Promise.all(
      metadataBlobs.map(async (blob) => {
        try {
          const response = await fetch(blob.url, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json();
        } catch (error) {
          return {
            createdAt: blob.uploadedAt.toISOString(),
            metadataUrl: blob.url,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    return res.status(200).json({
      ok: true,
      configured: true,
      userCode: USER_CODE,
      count: matches.length,
      matches,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      configured: true,
      userCode: USER_CODE,
      matches: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
