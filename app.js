const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { App } = require("@slack/bolt");
const { Client: Notion } = require("@notionhq/client");

// ============ ENV CHECK ============
console.log("ENV CHECK:", {
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ? "OK" : "MISSING",
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET ? "OK" : "MISSING",
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ? "OK" : "MISSING",
  NOTION_TOKEN: process.env.NOTION_TOKEN ? "OK" : "MISSING",
  NOTION_DB_ALLOWLIST: process.env.NOTION_DB_ALLOWLIST ? "OK" : "MISSING",
});
const required = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
  "NOTION_TOKEN",
  "NOTION_DB_ALLOWLIST",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing ENV:", missing);
  process.exit(1);
}

// ============ Slack / Notion ============
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const notion = new Notion({ auth: process.env.NOTION_TOKEN });
const DB_ALLOW = (process.env.NOTION_DB_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ============ /askme: 検索→結果リンクを表示 ============
app.command("/askme", async ({ ack, respond, command, logger }) => {
  await ack();
  const q = (command.text || "").trim();

  if (!q) {
    await respond({
      response_type: "ephemeral",
      text: "使い方：`/askme <検索ワード>` 例：`/askme 出張 精算`",
    });
    return;
  }

  try {
    const res = await smartSearch(q);

    if (!res.results.length) {
      await respond({
        response_type: "in_channel",
        text: `*Notionで見つかりませんでした*: _${escapeMrkdwn(q)}_`,
        mrkdwn: true,
      });
      return;
    }

    // 上位5件をBlock Kitで整形して“チャンネル公開”
    const blocks = buildResultBlocks(q, res.results.slice(0, 5));
    await respond({
      response_type: "in_channel",
      blocks,
      text: `検索結果: ${q}`, // フォールバック
    });
  } catch (e) {
    logger.error(e);
    await respond({
      response_type: "ephemeral",
      text: "検索中にエラーが発生しました。DB共有設定と環境変数を確認してください。",
    });
  }
});

// ============ 管理コマンド：DB一覧 ============
app.command("/askme-admin", async ({ ack, respond, command }) => {
  await ack();
  const sub = (command.text || "").trim();
  if (sub !== "listdbs") {
    await respond("使い方: `/askme-admin listdbs`");
    return;
  }
  try {
    const r = await notion.search({ filter: { property: "object", value: "database" } });
    if (!r.results.length) {
      await respond("見つかったデータベースは0件でした。まずはNotion側でインテグレーションを招待してください。");
      return;
    }
    const lines = r.results.slice(0, 20).map((db, i) => {
      const title = (db.title || []).map((t) => t.plain_text).join("") || "(無題DB)";
      return `${i + 1}. ${title}\n   id: \`${db.id}\``;
    });
    await respond({ response_type: "ephemeral", text: "*アクセス可能なDB一覧（上位20件）*\n" + lines.join("\n") });
  } catch (e) {
    await respond("DB一覧の取得に失敗しました。共有設定を確認してください。");
  }
});

// ============ 検索ユーティリティ（DB query） ============
function tokenizeJa(q) {
  return q.trim().split(/\s+/).slice(0, 5);
}

async function detectSchema(dbId) {
  const db = await notion.databases.retrieve({ database_id: dbId });
  const props = db.properties || {};

  const titleKey = Object.keys(props).find((k) => props[k].type === "title");

  const tagKey = Object.keys(props).find(
    (k) =>
      props[k].type === "multi_select" &&
      ["tags", "tag", "カテゴリ", "カテゴリー", "category"].some((x) => k.toLowerCase().includes(x))
  );

  const statusKey = Object.keys(props).find(
    (k) =>
      props[k].type === "select" &&
      ["status", "公開状態", "状態"].some((x) => k.toLowerCase().includes(x.toLowerCase()))
  );

  const effKey = Object.keys(props).find(
    (k) =>
      props[k].type === "date" &&
      ["effective", "施行", "適用", "発効"].some((x) => k.toLowerCase().includes(x.toLowerCase()))
  );

  // あると便利：Summary（リッチテキスト）
  const summaryKey = Object.keys(props).find(
    (k) => props[k].type === "rich_text" && ["summary", "要約", "概要"].some((x) => k.toLowerCase().includes(x))
  );

  return { titleKey, tagKey, statusKey, effKey, summaryKey };
}

async function queryOneDB(dbId, q) {
  const { titleKey, tagKey, statusKey, effKey } = await detectSchema(dbId);
  const kws = tokenizeJa(q);

  const orFilters = [];
  if (titleKey) for (const k of kws) orFilters.push({ property: titleKey, title: { contains: k } });
  if (tagKey) for (const k of kws) orFilters.push({ property: tagKey, multi_select: { contains: k } });

  const andFilters = [];
  if (orFilters.length) andFilters.push({ or: orFilters });
  if (statusKey) andFilters.push({ property: statusKey, select: { equals: "Published" } });
  if (effKey)
    andFilters.push({
      or: [
        { property: effKey, date: { on_or_before: new Date().toISOString() } },
        { property: effKey, date: { is_empty: true } },
      ],
    });

  const filter = andFilters.length ? { and: andFilters } : undefined;

  return await notion.databases.query({
    database_id: dbId,
    filter,
    sorts: effKey ? [{ property: effKey, direction: "descending" }] : undefined,
    page_size: 10,
  });
}

async function smartSearch(q) {
  if (!DB_ALLOW.length) return { results: [] };
  const all = [];
  for (const dbId of DB_ALLOW) {
    try {
      const r = await queryOneDB(dbId, q);
      all.push(...r.results);
    } catch (e) {
      console.error("query fail on DB:", dbId, e?.message);
    }
  }
  // 重複排除
  const uniq = [];
  const seen = new Set();
  for (const p of all) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      uniq.push(p);
    }
  }
  return { results: uniq };
}

// ============ Block Kit ビルダー ============
function buildResultBlocks(query, pages) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Notion 検索結果（最大${pages.length}件）*: _${escapeMrkdwn(query)}_` },
    },
    { type: "divider" },
  ];

  for (const p of pages) {
    const { title, url, tags, summary, lastEdited } = summarizePageForList(p);

    const lines = [];
    if (summary) lines.push(`_${escapeMrkdwn(summary)}_`);
    if (tags && tags.length) lines.push(`• *Tags*: ${tags.map((t) => `\`${t}\``).join(" ")}`);
    lines.push(`• *更新*: ${lastEdited}`);

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${url}|${escapeMrkdwn(title)}>*\n${lines.join("\n")}`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "開く" },
        url,
        action_id: "open_link",
      },
    });
    blocks.push({ type: "divider" });
  }

  return blocks;
}

function summarizePageForList(page) {
  const url = page.url || "";
  const lastEdited = page.last_edited_time?.slice(0, 10) || "—";

  // タイトル
  let title = "Untitled";
  try {
    const titleProp = Object.values(page.properties || {}).find((p) => p.type === "title");
    if (titleProp?.title?.length) title = titleProp.title.map((t) => t.plain_text).join("");
  } catch {}

  // タグ（multi_selectを想定）
  let tags = [];
  try {
    const tagProp = Object.values(page.properties || {}).find((p) => p.type === "multi_select");
    if (tagProp?.multi_select?.length) tags = tagProp.multi_select.map((t) => t.name);
  } catch {}

  // Summary（rich_text）
  let summary = "";
  try {
    const summaryProp = Object.values(page.properties || {}).find(
      (p) => p.type === "rich_text" && (p.rich_text?.length || 0) > 0
    );
    if (summaryProp) summary = summaryProp.rich_text.map((t) => t.plain_text).join("").slice(0, 180);
  } catch {}

  return { title, url, tags, summary, lastEdited };
}

// ============ 小物 ============
function escapeMrkdwn(s) {
  return String(s).replace(/([_*`~])/g, "\\$1");
}

// ============ 起動：Socket Mode + Health HTTP ============
(async () => {
  await app.start();
  console.log("⚡️ very50-askme is running in Socket Mode!");

  const http = require("http");
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("very50-askme ok");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  server.listen(PORT, () => console.log(`🩺 health server listening on ${PORT}`));
})();
