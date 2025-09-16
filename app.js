const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

console.log("ENV CHECK:", {
  cwd: process.cwd(),
  envPath: path.join(__dirname, ".env"),
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ? "OK" : "MISSING",
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET ? "OK" : "MISSING",
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ? "OK" : "MISSING",
  NOTION_TOKEN: process.env.NOTION_TOKEN ? "OK" : "MISSING",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "OK" : "MISSING",
});

require("dotenv").config();
const { App } = require("@slack/bolt");
const { Client: Notion } = require("@notionhq/client");

// Bolt初期化の後あたりに追加（Expressに直接生やせます）
app.receiver.app.get("/", (_req, res) => res.status(200).send("very50-askme ok"));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const notion = new Notion({ auth: process.env.NOTION_TOKEN });

// /kb <キーワード> → Notion検索 → 上位5件のタイトルとURLを返す
app.command("/askme", async ({ ack, respond, command, logger }) => {
  await ack();
  const q = (command.text || "").trim();
  if (!q) {
    await respond("使い方：`/askme <検索ワード>` 例：`/askme 出張 精算`");
    return;
  }

  try {
    // 1) 検索
    const res = await notion.search({
      query: q,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
    if (!res.results.length) {
      await respond(`Notionで見つかりませんでした：*${q}*`);
      return;
    }

    // 2) 先頭ページの本文テキストを組み立て
    const page = res.results[0];
    const pageUrl = page.url || "";
    const title = getTitle(page) || "(無題)";

    const fullText = await getPagePlainText(notion, page.id, 6000); // 文字数上限

    if (!fullText.trim()) {
      await respond(`ページは見つかりましたが本文が取得できませんでした：<${pageUrl}|${escapeMrkdwn(title)}>`);
      return;
    }

    // 3) ChatGPTで要約
    const answer = await summarizeWithGPT(q, fullText, pageUrl);

    // 4) 返答
    await respond({
      response_type:"in_channel",
      text:
        `*質問*: _${escapeMrkdwn(q)}_\n` +
        `*対象*: <${pageUrl}|${escapeMrkdwn(title)}>\n\n` +
        `${answer}`,
      mrkdwn: true,
    });

  } catch (e) {
    logger.error(e);
    await respond("検索または要約中にエラーが発生しました。.env（NOTION_TOKEN/OPENAI_API_KEY）とNotionの共有設定を確認してください。");
  }
});

// ページタイトル抽出（Page objectのプロパティを安全に読む）
function getTitle(page) {
  try {
    // データベースのスキーマによってタイトルプロパティ名はまちまちなので総当りで拾う
    // 1) properties の中で "title" タイプのものを探す
    if (page.properties) {
      const prop = Object.values(page.properties).find(
        (p) => p.type === "title" && Array.isArray(p.title)
      );
      if (prop && prop.title.length) {
        return prop.title.map((t) => t.plain_text).join("");
      }
    }
    // 2) それでも無ければ Notion APIが返す "page.icon + 無題" などに頼る
    return page?.object === "page" ? "Untitled" : null;
  } catch {
    return null;
  }
}

// Slackのmrkdwnで意味を持つ記号を軽くエスケープ
function escapeMrkdwn(s) {
  return s.replace(/([_*`~])/g, "\\$1");
}

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ very50-askme is running (Socket Mode)!");
})();

async function getPagePlainText(notion, pageId, maxChars = 6000) {
  let text = "";
  let cursor;
  do {
    const resp = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const b of resp.results) {
      const t = extractPlainText(b);
      if (t) {
        if (text.length + t.length + 1 > maxChars) return text;
        text += t + "\n";
      }
      // 必要なら子ブロックの再帰取得も実装可能
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return text;
}

function extractPlainText(block) {
  const rt = (r = []) => r.map(x => x.plain_text).join("");
  switch (block.type) {
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "paragraph":
      return rt(block[block.type].rich_text);
    case "bulleted_list_item":
    case "numbered_list_item":
      return "・" + rt(block[block.type].rich_text);
    case "to_do":
      return (block.to_do.checked ? "[x] " : "[ ] ") + rt(block.to_do.rich_text);
    case "quote":
      return "“" + rt(block.quote.rich_text) + "”";
    default:
      return ""; // テーブルや画像などはスキップ
  }
}

// ChatGPT要約
async function summarizeWithGPT(question, sourceText, pageUrl) {
  const OpenAI = require("openai");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = [
    "あなたはvery50の社内ナレッジ係です。",
    "以下の原文を厳密に参照し、ユーザーの質問に日本語で簡潔かつポジティブで優しいイメージで答えてください。",
    "- まず最初に結論を1-3行で。",
    "- 次に箇条書きで手順/条件/例外/期限など実務に必要な要点を整理しつつ新入社員にもわかりやすく伝えること。",
    "- 原文にない推測はしないこと。",
    `- 最後に「出典：${pageUrl}」と書く。`,
    "",
    "【ユーザーの質問】",
    question,
    "",
    "【原文（抜粋）】",
    sourceText,
  ].join("\n");

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
  });

  return resp.output_text || "要約を生成できませんでした。";
}