import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const config = { maxDuration: 60 };

const USER_CODE = "3032582018";
const PLAYER_NAME = "おばけたろう";
const SOURCE_URL = `https://sf6replay.tail4a2c75.ts.net/player.html?short_id=${USER_CODE}`;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function findAfter(lines, label) {
  const i = lines.findIndex((x) => x === label || x.startsWith(label));
  return i >= 0 ? (lines[i + 1] ?? null) : null;
}

function parseText(bodyText, tables, links) {
  const lines = bodyText.split(/\r?\n/).map(clean).filter(Boolean);

  const currentRaw = findAfter(lines, "Current MR / LP");
  const mrMatch = (currentRaw || "").match(/MR\s*([\d,]+)/i);
  const lpMatch = (currentRaw || "").match(/LP\s*([\d,]+)/i);

  const peakLine = lines.find((x) => /^Peak MR:/i.test(x));
  const peakMatch = (peakLine || "").match(/Peak MR:\s*([\d,]+)/i);

  const lastPlayed = findAfter(lines, "Last Played");
  const shortIdLine = lines.find((x) => x.includes(`short_id: ${USER_CODE}`));
  const playerName = shortIdLine
    ? lines[Math.max(0, lines.indexOf(shortIdLine) - 1)].replace(/^#+\s*/, "")
    : (lines.find((x) => x === PLAYER_NAME) || PLAYER_NAME);

  const battleTable = tables.find((t) => {
    const h = (t.headers || []).join(" | ");
    return /Time/i.test(h) && /Opponent/i.test(h) && /Result/i.test(h);
  });

  const characterTable = tables.find((t) => {
    const h = (t.headers || []).join(" | ");
    return /Character/i.test(h) && /MR/i.test(h) && /Win Rate/i.test(h);
  });

  const recentMatches = (battleTable?.rows || []).slice(0, 30).map((row) => {
    const h = battleTable.headers || [];
    const obj = {};
    h.forEach((key, i) => {
      if (key) obj[key] = row[i] ?? "";
    });
    return obj;
  });

  const replayLinks = links
    .filter((x) => /replay|録画|detail|analysis|youtube/i.test(`${x.text} ${x.href}`))
    .slice(0, 50);

  const coachingStart = lines.findIndex((x) =>
    /Overall Trend|AI Summary|Recent Notes|傾向コーチング|総評|AIコーチ/i.test(x)
  );
  const coachingText =
    coachingStart >= 0 ? lines.slice(coachingStart, coachingStart + 120).join("\n") : "";

  const stillLoading = /CFNプロフィールを取得中|対戦履歴を取得中|Loading\.\.\./i.test(bodyText);

  return {
    userCode: USER_CODE,
    playerName: clean(playerName),
    currentMR: mrMatch ? Number(mrMatch[1].replace(/,/g, "")) : null,
    currentLP: lpMatch ? Number(lpMatch[1].replace(/,/g, "")) : null,
    peakMR: peakMatch ? Number(peakMatch[1].replace(/,/g, "")) : null,
    lastPlayed: clean(lastPlayed),
    favoriteCharacter: clean(findAfter(lines, "Favorite Character")),
    recentMatches,
    characterStats: characterTable
      ? characterTable.rows.slice(0, 40).map((row) => {
          const obj = {};
          characterTable.headers.forEach((key, i) => {
            if (key) obj[key] = row[i] ?? "";
          });
          return obj;
        })
      : [],
    replayLinks,
    coachingText,
    stillLoading,
    rawText: bodyText.slice(0, 50000)
  };
}

async function scrape() {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36"
    );

    await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const text = await page.evaluate(() => document.body?.innerText || "");
      const ready =
        text.includes(USER_CODE) &&
        !/CFNプロフィールを取得中|対戦履歴を取得中/.test(text) &&
        (/Current MR \/ LP/.test(text) || /現在MR|MR\s*\d+/i.test(text));
      if (ready) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const tables = await page.$$eval("table", (els) =>
      els.map((table) => {
        const headers = Array.from(table.querySelectorAll("thead th")).map((x) =>
          (x.textContent || "").replace(/\s+/g, " ").trim()
        );
        const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
          Array.from(tr.querySelectorAll("th,td")).map((td) =>
            (td.textContent || "").replace(/\s+/g, " ").trim()
          )
        );
        return { headers, rows };
      })
    );
    const links = await page.$$eval("a[href]", (els) =>
      els.map((a) => ({
        text: (a.textContent || "").replace(/\s+/g, " ").trim(),
        href: a.href
      }))
    );

    return parseText(bodyText, tables, links);
  } finally {
    if (browser) await browser.close();
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const fetchedAt = new Date().toISOString();

  try {
    const data = await scrape();
    const useful =
      data.currentMR !== null ||
      data.recentMatches.length > 0 ||
      data.rawText.includes(USER_CODE);

    res.status(useful ? 200 : 502).json({
      ok: useful,
      fresh: useful && !data.stillLoading,
      fetchedAt,
      sourceUrl: SOURCE_URL,
      ...data,
      error: useful ? null : "Upstream page loaded but player data was not available yet."
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      fresh: false,
      fetchedAt,
      sourceUrl: SOURCE_URL,
      userCode: USER_CODE,
      playerName: PLAYER_NAME,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
