import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { upload } from "@vercel/blob/client";
import OBSWebSocket from "obs-websocket-js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = join(scriptDirectory, "config.json");
const statePath = join(scriptDirectory, "recorder-state.json");

function now() {
  return new Date().toISOString();
}

function log(message, details) {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(`[${now()}] ${message}${suffix}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function fingerprintMatch(match) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(match)))
    .digest("hex")
    .slice(0, 24);
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function saveState(state) {
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

function validateConfig(config) {
  const missing = [];
  if (!config.userCode) missing.push("userCode");
  if (!config.bridgeStateUrl) missing.push("bridgeStateUrl");
  if (!config.uploadUrl) missing.push("uploadUrl");
  if (!config.recorderApiKey || config.recorderApiKey.includes("RECORDER_API_KEY")) {
    missing.push("recorderApiKey");
  }
  if (!config.obs?.url) missing.push("obs.url");
  if (missing.length) {
    throw new Error(`config.jsonの設定が不足しています: ${missing.join(", ")}`);
  }
}

async function fetchBridgeState(config) {
  const url = new URL(config.bridgeStateUrl);
  url.searchParams.set("ts", Date.now().toString());
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json();
  if (!response.ok || !body.ok || !body.fresh) {
    throw new Error(body.error || `Bridge HTTP ${response.status}`);
  }
  if (!Array.isArray(body.recentMatches)) {
    throw new Error("BridgeにrecentMatchesがありません。");
  }
  return body;
}

async function connectObs(config) {
  const obs = new OBSWebSocket();
  await obs.connect(config.obs.url, config.obs.password || undefined, {
    rpcVersion: 1,
  });
  log("OBSへ接続しました。", { url: config.obs.url });

  const status = await obs.call("GetReplayBufferStatus");
  if (!status.outputActive) {
    await obs.call("StartReplayBuffer");
    log("OBSリプレイバッファを開始しました。");
  } else {
    log("OBSリプレイバッファはすでに動作中です。");
  }
  return obs;
}

function waitForReplaySaved(obs, timeoutMs = 30_000) {
  let onSaved;
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      obs.off("ReplayBufferSaved", onSaved);
      reject(new Error("OBSから保存完了通知が届きませんでした。"));
    }, timeoutMs);

    onSaved = function onReplayBufferSaved(event) {
      clearTimeout(timer);
      resolve(event.savedReplayPath);
    };

    obs.once("ReplayBufferSaved", onSaved);
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      obs.off("ReplayBufferSaved", onSaved);
    },
  };
}

async function saveReplayBuffer(obs) {
  const saved = waitForReplaySaved(obs);
  try {
    await obs.call("SaveReplayBuffer");
  } catch (error) {
    saved.cancel();
    throw error;
  }
  const savedReplayPath = await saved.promise;
  log("OBSリプレイを保存しました。", { path: savedReplayPath });
  return savedReplayPath;
}

async function waitForFileReady(path, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let previousSize = -1;
  let stableCount = 0;

  while (Date.now() < deadline) {
    try {
      const info = await stat(path);
      if (info.size > 0 && info.size === previousSize) {
        stableCount += 1;
        if (stableCount >= 2) return info;
      } else {
        previousSize = info.size;
        stableCount = 0;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(1_000);
  }
  throw new Error(`録画ファイルの確定を待てませんでした: ${path}`);
}

function videoContentType(path) {
  const extension = extname(path).toLowerCase();
  return {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  }[extension] || "application/octet-stream";
}

async function verifyUploadedVideo(blob, expectedSize) {
  const response = await fetch(blob.url, {
    method: "HEAD",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`アップロード確認がHTTP ${response.status}でした。`);
  }

  const uploadedSize = Number(response.headers.get("content-length") || 0);
  if (uploadedSize && uploadedSize !== expectedSize) {
    throw new Error(`アップロード容量が一致しません: ${uploadedSize}/${expectedSize}`);
  }
}

async function uploadPending(config, state) {
  const pending = state.pending;
  if (!pending) return;

  await access(pending.videoPath);
  const info = await waitForFileReady(pending.videoPath);
  const extension = extname(pending.videoPath).toLowerCase() || ".mp4";
  const safeTime = pending.metadata.detectedAt.replace(/[:.]/g, "-");
  const pathname = `sf6/videos/${config.userCode}/${safeTime}-${pending.metadata.matchKey}${extension}`;
  let lastProgress = -10;

  log("動画をアップロードします。", {
    file: basename(pending.videoPath),
    sizeMB: Math.round((info.size / 1024 / 1024) * 10) / 10,
  });

  const blob = await upload(pathname, createReadStream(pending.videoPath), {
    access: "public",
    handleUploadUrl: config.uploadUrl,
    headers: {
      Authorization: `Bearer ${config.recorderApiKey}`,
    },
    clientPayload: JSON.stringify(pending.metadata),
    contentType: videoContentType(pending.videoPath),
    multipart: true,
    onUploadProgress(progress) {
      const rounded = Math.floor(progress.percentage / 10) * 10;
      if (rounded >= lastProgress + 10) {
        lastProgress = rounded;
        log(`アップロード ${Math.min(100, rounded)}%`);
      }
    },
  });

  await verifyUploadedVideo(blob, info.size);
  log("アップロードを確認しました。", { url: blob.url });

  if (config.deleteAfterUpload !== false) {
    await unlink(pending.videoPath);
    log("送信済み動画をPCから削除しました。", { path: pending.videoPath });
  }

  state.lastMatchKey = pending.metadata.matchKey;
  state.lastUploadedAt = now();
  state.lastVideoUrl = blob.url;
  state.pending = null;
  await saveState(state);
}

async function processMatch(config, state, obs, match) {
  const matchKey = fingerprintMatch(match);
  const videoPath = await saveReplayBuffer(obs);
  const metadata = {
    userCode: String(config.userCode),
    playerName: String(config.playerName || "おばけたろう"),
    matchKey,
    detectedAt: now(),
    match,
  };

  state.pending = { videoPath, metadata };
  await saveState(state);
  await uploadPending(config, state);
}

async function main() {
  const config = await loadJson(configPath, null);
  if (!config) {
    throw new Error("config.jsonがありません。install-recorder.cmdを先に実行してください。");
  }
  validateConfig(config);

  const state = await loadJson(statePath, {
    lastMatchKey: null,
    lastUploadedAt: null,
    lastVideoUrl: null,
    pending: null,
  });

  let obs = await connectObs(config);
  if (state.pending) {
    try {
      log("前回未完了のアップロードを再開します。");
      await uploadPending(config, state);
    } catch (error) {
      log("未完了アップロードは次回再試行します。", { error: error.message });
    }
  }

  log("SF6の新しい試合を監視します。", {
    userCode: config.userCode,
    intervalSeconds: Number(config.pollSeconds || 20),
    deleteAfterUpload: config.deleteAfterUpload !== false,
  });

  while (true) {
    try {
      if (state.pending) {
        log("未完了の動画送信を再試行します。");
        await uploadPending(config, state);
      }

      const bridge = await fetchBridgeState(config);
      const latestMatch = bridge.recentMatches[0];
      if (!latestMatch) {
        log("対戦履歴はまだありません。");
      } else {
        const latestKey = fingerprintMatch(latestMatch);
        if (!state.lastMatchKey) {
          state.lastMatchKey = latestKey;
          await saveState(state);
          log("現在の最新試合を基準として登録しました。次の試合から録画します。");
        } else if (latestKey !== state.lastMatchKey && !state.pending) {
          log("新しい試合を検知しました。", { matchKey: latestKey });
          await processMatch(config, state, obs, latestMatch);
        }
      }
    } catch (error) {
      log("監視処理でエラーが発生しました。自動で再試行します。", {
        error: error instanceof Error ? error.message : String(error),
      });

      if (/OBS|WebSocket|socket|connect/i.test(String(error?.message || error))) {
        try {
          obs.disconnect();
        } catch {}
        try {
          obs = await connectObs(config);
        } catch (reconnectError) {
          log("OBS再接続待ちです。", { error: reconnectError.message });
        }
      }
    }

    await sleep(Math.max(10, Number(config.pollSeconds || 20)) * 1_000);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(`\n起動できませんでした: ${error.message}\n`);
    process.exitCode = 1;
  });
}
