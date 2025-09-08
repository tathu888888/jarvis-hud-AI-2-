

// server.js (整理版)
import express from "express";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import OpenAI from "openai";
import "dotenv/config";

const app = express();
app.use(express.json({ limit: "10mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set. Check your .env");
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========== /api/annotate ==========
app.post("/api/annotate", async (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ error: "title is required" });

    const oaRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [
          {
            role: "system",
            content:
              "You are a concise news explainer. Summarize a news headline in Japanese with 1-2 sentences and add one plausible angle or implication. Keep it neutral.",
          },
          {
            role: "user",
            content: `ヘッドライン: ${title}\n出力: 80〜140文字で要約し、最後に「— 観点: …」と1行追加して。`,
          },
        ],
        temperature: 0.5,
      }),
    });

    if (!oaRes.ok) {
      const t = await oaRes.text();
      return res.status(502).json({ error: "openai_error", detail: t });
    }

    const json = await oaRes.json();
    const note =
      json.output_text ??
      json.output?.[0]?.content?.[0]?.text ??
      json.content?.[0]?.text ??
      json.response?.[0]?.content?.[0]?.text ??
      json.message?.content?.[0]?.text ??
      JSON.stringify(json);

    return res.json({ note });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

// ========== RSSユーティリティ ==========
const cache = new Map(); // key: url, val: { at, body, contentType }

async function fetchFeed(url) {
  const cached = cache.get(url);
  const now = Date.now();
  if (cached && now - cached.at < 60_000) return cached;

  const r = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (NewsHUD RSS Fetcher)",
      "accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    },
  });
  if (!r.ok) throw new Error(`fetch fail ${r.status}`);
  const body = await r.text();
  const contentType = r.headers.get("content-type") || "application/xml; charset=utf-8";

  const rec = { at: now, body, contentType };
  cache.set(url, rec);
  return rec;
}

function sniffFeedType(xml) {
  if (/<\s*rss[\s>]/i.test(xml)) return "rss";
  if (/<\s*feed[\s>]/i.test(xml)) return "atom";
  if (/<\s*rdf:RDF[\s>]/i.test(xml)) return "rdf";
  return "xml";
}

function normalizeToItems(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    allowBooleanAttributes: true,
    trimValues: true,
  });
  const obj = parser.parse(xml);
  const type = sniffFeedType(xml);

  const items = [];
  const strip = (s) => (s ?? "").toString();

  if (type === "rss" && obj?.rss?.channel) {
    const ch = obj.rss.channel;
    const arr = Array.isArray(ch.item) ? ch.item : (ch.item ? [ch.item] : []);
    for (const n of arr) {
      items.push({
        title: strip(n.title),
        url: strip(n.link || n.guid),
        time: strip(n.pubDate || n["dc:date"] || ""),
        summary: strip(n.description || n["content:encoded"] || ""),
        image:
          strip(n?.enclosure?.url) ||
          strip(n?.["media:thumbnail"]?.url) ||
          strip(n?.["media:content"]?.url) ||
          "",
        source: strip(ch.title || ""),
      });
    }
    return { type, title: strip(ch.title || ""), link: strip(ch.link || ""), items };
  }

  if (type === "atom" && obj?.feed) {
    const f = obj.feed;
    const arr = Array.isArray(f.entry) ? f.entry : (f.entry ? [f.entry] : []);
    for (const n of arr) {
      let href = "";
      if (n.link) {
        if (Array.isArray(n.link)) {
          const alt = n.link.find((x) => x.rel === "alternate" && x.href) || n.link.find((x) => x.href);
          href = alt?.href ?? "";
        } else {
          href = n.link.href ?? "";
        }
      }
      items.push({
        title: strip(n.title),
        url: strip(href || n.id || ""),
        time: strip(n.updated || n.published || ""),
        summary: strip(n.summary || n.content || ""),
        image: "",
        source: strip(f.title || ""),
      });
    }
    return { type, title: strip(f.title || ""), link: strip(f.link?.href || ""), items };
  }

  if (type === "rdf" && obj?.["rdf:RDF"]) {
    const r = obj["rdf:RDF"];
    const channel = Array.isArray(r.channel) ? r.channel[0] : r.channel || {};
    const arr = Array.isArray(r.item) ? r.item : (r.item ? [r.item] : []);
    for (const n of arr) {
      items.push({
        title: strip(n.title),
        url: strip(n.link || n.guid),
        time: strip(n["dc:date"] || n.date || n.pubDate || ""),
        summary: strip(n.description || ""),
        image: "",
        source: strip(channel.title || ""),
      });
    }
    return { type, title: strip(channel.title || ""), link: strip(channel.link || ""), items };
  }

  return { type: "xml", title: "", link: "", items: [] };
}

function buildRSS2({ title = "Aggregated Feed", link = "", description = "", items = [] }) {
  const esc = (s) =>
    (s ?? "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const rssItems = items
    .map((it) => {
      const dt = it.time ? new Date(it.time) : null;
      const pubDate = dt && !isNaN(dt.getTime()) ? dt.toUTCString() : "";
      const enclosure = it.image ? `\n      <enclosure url="${esc(it.image)}" type="image/jpeg" />` : "";
      return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.url)}</link>
      ${pubDate ? `<pubDate>${esc(pubDate)}</pubDate>` : ""}
      <description>${esc(it.summary)}</description>${enclosure}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(link)}</link>
    <description>${esc(description || title)}</description>
${rssItems}
  </channel>
</rss>`;
}

// ========== /api/rss (raw|json|rss) ==========
app.get("/api/rss", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    const format = String(req.query.format || "raw"); // raw | json | rss
    if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad url");

    const { body, contentType } = await fetchFeed(url);

    if (format === "raw") {
      const kind = sniffFeedType(body);
      if (kind === "rss") res.set("content-type", "application/rss+xml; charset=utf-8");
      else if (kind === "atom") res.set("content-type", "application/atom+xml; charset=utf-8");
      else res.set("content-type", contentType || "application/xml; charset=utf-8");
      return res.send(body);
    }

    const normalized = normalizeToItems(body);

    if (format === "json") {
      res.set("content-type", "application/json; charset=utf-8");
      return res.json(normalized);
    }

    if (format === "rss") {
      const rssXml = buildRSS2({
        title: normalized.title || "Converted Feed",
        link: normalized.link || url,
        description: `${normalized.title || "Feed"} via NewsHUD`,
        items: normalized.items,
      });
      res.set("content-type", "application/rss+xml; charset=utf-8");
      return res.send(rssXml);
    }

    return res.status(400).send("unknown format");
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ========== /api/aggregate ==========
app.get("/api/aggregate", async (req, res) => {
  try {
    const feeds = String(req.query.feeds || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const format = String(req.query.format || "rss");

    if (!feeds.length) return res.status(400).send("feeds required");

    const all = [];
    for (const u of feeds) {
      if (!/^https?:\/\//i.test(u)) continue;
      try {
        const { body } = await fetchFeed(u);
        const norm = normalizeToItems(body);
        for (const it of norm.items) {
          if (it.source) it.title = `[${it.source}] ${it.title}`;
        }
        all.push(...norm.items);
      } catch (e) {
        console.warn("aggregate fetch fail:", u, e.message);
      }
    }

    const parsed = all.map((it) => ({ ...it, _ts: Date.parse(it.time || "") || 0 }));
    parsed.sort((a, b) => b._ts - a._ts);

    if (format === "json") {
      res.set("content-type", "application/json; charset=utf-8");
      return res.json({ title: "Aggregated Feed", items: parsed });
    }

    if (format === "rss") {
      const rssXml = buildRSS2({
        title: "Aggregated Feed",
        link: "",
        description: "Merged by NewsHUD",
        items: parsed,
      });
      res.set("content-type", "application/rss+xml; charset=utf-8");
      return res.send(rssXml);
    }

    return res.status(400).send("unknown format");
  } catch (e) {
    res.status(500).send(String(e));
  }
});





// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL_FAST = "gpt-4o-mini"; // 部分要約用（高速・安価）
const MODEL_FINAL = "gpt-4o";     // 最終統合用（精度重視）

// Responses APIを叩いて "output_text" を取り出すユーティリティ（json_object前提）
async function callResponses({ model, system, user, temperature = 0.2 }) {
  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ],
    temperature,
    // ★指定の型式：JSONオブジェクトで返す（スキーマは緩め。最終で検証・補完）
    text: { format: { type: "json_object" } },
  };
  const r = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  
  const raw = await r.text();
  if (!r.ok) {
    // OpenAIのエラーをそのまま透過（デバッグしやすい）
    throw new Error(`OpenAI ${r.status}: ${raw}`);
  }

  // 代表形：{ output: [{ content: [{ type:"output_text", text:"{...}"}]}], ... }
  let data; try { data = JSON.parse(raw); } catch { throw new Error(`Non-JSON from OpenAI: ${raw}`); }
  const textOut =
    data?.output?.[0]?.content?.[0]?.type === "output_text"
      ? data.output[0].content[0].text
      : null;

  if (!textOut) throw new Error(`no_output_text: ${raw}`);
  return textOut; // ← JSON文字列（json_object指定なのでObject化は呼び出し側で）
}

// 小分け（60件/チャンク想定）
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

app.post("/api/forecast", async (req, res) => {
  try {
    const { items = [], horizonDays = 14 } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    // 送信データ（title/summary/source/time + note(ai) を含める）
    const compact = items.slice(0, 600).map(a => ({
      title:   a?.title   ?? "",
      summary: a?.summary ?? "",
      source:  a?.source  ?? "",
      time:    a?.time    ?? "",
      note:    a?.ai ?? a?.note ?? "",   // ★ 重要：noteを同梱
    }));

    // ===== 1) MAP: チャンク要約（themes & signals のみ）=====
    const CHUNK_SIZE = 60;
    const groups = chunk(compact, CHUNK_SIZE);

    const mapPromises = groups.map((group, idx) => {
      const sys = "Answer in Japanese unless the input is in another language.";
      const usr =
        [
          "You are WORLD FORECAST writer with an astrology lens.",
  "Always ground every section in the user's natural-language prompt (quoted below).",
  "Never ignore or replace the user's intent; instead, extract it and explicitly tie each insight back to it.",
  "",
  "Rules:",
  "- Start with a 1–2 sentence \"Prompt Echo\" that paraphrases the user's request using their own key terms.",
  "- In each section, include at least one explicit reference to a concept from the user's prompt.",
  "- If the user's prompt mentions zodiac signs/planets/aspects, map them to concrete world themes (e.g., Taurus → resources/energy; Mars → conflict; Mercury → comms/tech).",
  "- Refuse violent or hateful instructions; otherwise be helpful and neutral.",
  "",
  "Self-check before finalizing:",
  "- Relevance ≥ 0.8: Every section must reference ≥1 term/entity from the user's prompt.",
  "- Coverage: Address all explicit themes in the user's prompt.",
  "- Consistency: No contradictions across sections.",
  "",
  // 追加指定（日本語優先）
  "Answer in Japanese unless the input is in another language.",
   "必ず有効な JSON 形式で返してください（追加のテキストは不要です）。",
].join("\\n");
      return callResponses({ model: MODEL_FAST, system: sys, user: usr, temperature: 0.2 })
        .then(txt => {
          try { return JSON.parse(txt); }
          catch { throw new Error(`Chunk#${idx} invalid JSON: ${txt}`); }
        });
    });

    const partials = await Promise.all(mapPromises);

    // ===== 2) REDUCE: 最終統合（ホロスコープ＆ガイア理論含む完全JSON）=====
    const sysFinal = "Answer in Japanese unless the input is in another language.";
    const usrFinal = [
      "<USER_PROMPT>",
      "${USER_PROMPT}",
      "</USER_PROMPT>",
      "",
      "あなたは地政学アナリストです。同時に、西洋占星術のアーキタイプとガイア理論（地球を一つの自己調整システムとみなす仮説）を“比喩”として用いて、ニュースの含意をわかりやすく説明します（断定・占断はしない）。",
      "Timezone: JST. Horizon: ${horizonDays} days.",
      "CHUNK_SUMMARIES を統合して、近未来（7〜14日）の世界動向予報を作成してください。",
      "",
      "出力は次のキーを持つ単一の JSON オブジェクトとします：",
      "as_of_jst (string),",
      "coverage_count (int),",
      "top_themes (string[]),",
      "signals (array of { headline, why_it_matters, region?, confidence? (0-1), window_days? (int), why_related_to_prompt (string) }),",
      "scenarios_7_14d (array of { name, description, probability (0-1), triggers[], watchlist[], link_to_prompt (string) }),",
      "gaia_lens (object: { climate_signals: string[], environmental_risks: string[], note: string }),",
      "horoscope_narrative (string),",
      "caveats (string),",
      "confidence_overall (0-1 number),",
      "prompt_echo (string),",
      "relevance_score_selfcheck (0-1 number).",
      "",
      "Rules:",
      "- 事実根拠は CHUNK_SUMMARIES に含意される範囲のみ。新事実を作らない。",
      "- 簡潔で明瞭に。数値は 0〜1 の小数（例: 0.72）。",
      "- 日本語で書く。",
      "- 占星術・ガイア理論は“比喩・物語装置”としてのみ使用し、天体配置や地球意識を事実として主張しない。",
      "- 各セクション（top_themes / signals / scenarios_7_14d / gaia_lens / horoscope_narrative / caveats）は <USER_PROMPT> の語を最低1つ以上、明示的に参照すること。",
      "- relevance_score_selfcheck が 0.8 未満になりそうな場合は推論を見直し、>= 0.8 を満たすまで修正すること。",
      "",
      "占星術レンズ（比喩の指針）:",
      "- 牡羊座: 先制・衝突・軍事的イニシアチブ",
      "- 牡牛座: 資源・物価・エネルギー・供給網",
      "- 双子座: 情報・通信・世論・テック伝搬",
      "- 蟹座: 内政・領土防衛・避難民・社会的安全網",
      "- 獅子座: 指導者・威信・レジームの演出",
      "- 乙女座: 保健・生産性・品質・ロジスティクス",
      "- 天秤座: 外交・同盟・法制度・均衡",
      "- 蠍座: 秘密・金融リスク・制裁・情報機関",
      "- 射手座: 外交圏拡大・理念・越境政策",
      "- 山羊座: 制度・規制・官僚制・マクロ安定",
      "- 水瓶座: 破壊的技術・ネットワーク・社会運動",
      "- 魚座: 人道・災害・境界の溶解・誤情報",
      "",
      "天体アーキタイプ・レンズ（比喩補助）:",
      "- 太陽: コア・統治意思・国家目標の焦点",
      "- 月: 民意・生活感情・社会の安全欲求",
      "- 水星: 情報伝達・交渉戦術・サプライの細線",
      "- 金星: 価値・同盟の融和・資本の好悪",
      "- 火星: 行動力・軍事ドライブ・衝突コスト",
      "- 木星: 拡張・国際秩序・規模の経済",
      "- 土星: 制度・規制・デフォルト回避の抑制力",
      "- 天王星: 破壊的技術・エネルギー転換・制度逸脱",
      "- 海王星: 物語・幻影・誤情報・境界の溶解",
      "- 冥王星: 構造転換・集中と再配分・影の権力",
      "- 彗星: 突発ショック・非連続なイベント注入（例: ハレー彗星=周期的話題の再来）",
      "- 小惑星帯/外縁天体: 断片的リスクの群発・ニッチ領域の波及（例: ケレス/ベスタ=マイナー資源）",
      "- トロヤ群小惑星: 影の随伴勢力・同盟の“追随”",
      "- オールトの雲: 長周期の潜在リスク・遠因",
      "- カイパーベルト: 周縁ノード・境界領域のルール形成",
      "- ラグランジュ点（L1/L2）: 観測・監視・介入の窓（早期警戒の比喩）",
      "- 太陽黒点/太陽活動（CME）: 通信障害・市場ボラティリティに似た周期的撹乱",
      "- 銀河系（ミルキーウェイ）: システム全体の文脈・長周期の潮流",
      "- 銀河中心（いて座A*）: 集中・重力の焦点・資源/権力の集中",
      "- 大小マゼラン雲: 周辺からの補給・外部依存",
      "- アンドロメダ銀河: 外縁からの視座・遠心力・勢力圏の競合",
      "- パルサー: 定期信号・規律・リズム",
      "- クエーサー: 極端なエネルギー・過剰流動性・過熱",
      "- ダークマター/ダークエネルギー: 見えない構造・不可視の圧力（測れないが効いている要因）",
      "- シリウス/アルクトゥルス/プレアデス/オリオン/ポラリス/スピカ/レグルス/アンタレス/アルデバラン などは象徴のみ（事実主張しない）",
      "- ニビル等の仮説天体は“未確認伝承に基づく不安の比喩”としてのみ扱う（事実主張しない）",
      "",
      "ガイア理論レンズ（比喩の指針）:",
      "- 大気・海洋・生態系のバランス",
      "- 災害や異常気象の波及",
      "- 人類活動と地球システムのフィードバック",
      "- エネルギー・資源利用の持続性",
      "",
      "各セクションの書き方:",
      "- top_themes: CHUNK_SUMMARIES から主要3〜6テーマ。占星術語・ガイア表現は付記レベルに留める。",
      "- signals[].confidence: 出典の明確さ・一致度・時期近接性から 0〜1 で主観スコア化。",
      "- signals[].why_related_to_prompt: <USER_PROMPT> のどの語（例: 牡牛座=資源 / 水星=情報 / 火星=緊張）と結びつくかを1行で明示。",
      "- scenarios_7_14d: 2〜4件。名称は短く、引き金（triggers）と監視項目（watchlist）を具体化。",
      "- scenarios_7_14d[].link_to_prompt: 各シナリオが <USER_PROMPT> のどの語と対応するかを明示。",
      "- gaia_lens: 気候・環境に関する含意を抽出。ガイア比喩を1〜2文加える。",
      "- horoscope_narrative: 2〜5文。12サイン比喩＋上記天体レンズを織り交ぜて“今期の空気感”を説明。",
      "- caveats: データ偏り、タイムラグ、シグナルの不確実性。",
      "- confidence_overall: 全体の自信度を 0〜1。",
      "- prompt_echo: ユーザー自然文の要点を 1–2 文でパラフレーズ。",
      "- relevance_score_selfcheck: モデル自身による関連度の自己採点（0〜1）。0.8 未満は不可。",
      "",
      "CHUNK_SUMMARIES:",
      "${JSON.stringify(partials)}"
    ].join("\\n");

    const finalText = await callResponses({
      model: MODEL_FINAL,
      system: sysFinal,
      user: usrFinal,
      temperature: 0.3,
    });

    // 最終JSONをパース
    let json;
    try { json = JSON.parse(finalText); }
    catch {
      // 念のため { ... } 抽出フォールバック
      const first = finalText.indexOf("{"), last = finalText.lastIndexOf("}");
      if (first >= 0 && last >= first) json = JSON.parse(finalText.slice(first, last + 1));
      else throw new Error(`invalid_final_json: ${finalText}`);
    }

    // 最低限の補完
    if (!json.as_of_jst) {
      json.as_of_jst = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    }
    json.coverage_count = compact.length;

    // 数値域の正規化（confidence系を0-1で揃える）
    if (Array.isArray(json.signals)) {
      json.signals = json.signals.map(s => ({
        ...s,
        confidence: typeof s?.confidence === "number"
          ? Math.max(0, Math.min(1, s.confidence))
          : undefined
      }));
    }
    if (typeof json.confidence_overall === "number") {
      json.confidence_overall = Math.max(0, Math.min(1, json.confidence_overall));
    }

    return res.json(json);
  } catch (e) {
    console.error("forecast error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});


const makeId = (x, i) => String(x?.id ?? i);

app.post("/api/select_articles", async (req, res) => {
  const started = Date.now();
  try {
    let { query, items = [], limit = 120 } = req.body || {};

    // 互換: articles でも受け付ける
    if ((!Array.isArray(items) || items.length === 0) && Array.isArray(req.body?.articles)) {
      items = req.body.articles;
    }

    // 入力チェック（query は必須、items は任意に緩和）
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "query is required", detail: "missing query" });
    }
    if (!Array.isArray(items)) items = [];

    // items が空なら「フレーズ抽出専用モード」
    if (items.length === 0) {
      // モデルに軽く投げて phrases だけ貰う（失敗時は簡易トークナイズ）
      let phrases = [];
      try {
        const sys = `あなたはニュース選別のアナリストです。クエリから解析に本質的に必要な「短いフレーズ」を3〜8個抽出してください。
出力は厳密なJSONのみ: { "phrases": string[] }`;
        const usr = JSON.stringify({ query });

        const txt = await callResponses({
          model: "gpt-4o-mini",
          system: sys,
          user: usr,
          temperature: 0.2,
          format: "json",
        });
        const out = JSON.parse(txt || "{}");
        if (Array.isArray(out?.phrases)) phrases = out.phrases.slice(0, 16);
      } catch (_) {
        const tokens = (query.toLowerCase().match(/"[^"]+"|[^\s]+/g) || []).map(t => t.replace(/"/g, ""));
        phrases = tokens.slice(0, 10);
      }
      return res.json({
        phrases,
        selected_ids: [],
        _meta: { took_ms: Date.now() - started, used_fallback: false, engine: "responses", mode: "phrases_only" }
      });
    }

    // ===== items がある通常モード =====

    // モデルへ渡す簡潔版（IDは item.id or index のみに固定）
    const condensed = items.slice(0, 500).map((x, i) => ({
      id: makeId(x, i),
      title: x?.title?.slice(0,160) || "",
      summary: x?.summary?.slice(0,400) || "",
      source: x?.source || "",
      time: x?.time || ""
    }));

    const sys = `あなたはニュース選別のアナリストです。与えられた自然言語クエリに対し、
- 解析に本質的に必要な「短いフレーズ」候補を3〜8個抽出（日本語/英語混在可）
- そのフレーズで説明可能なカードだけを選び、最大 ${limit} 件に厳選
厳選の基準: タイトル/要約/ソース/時刻がクエリの意図に明確に関係すること。
出力は厳密なJSONのみ: { "phrases": string[], "selected_ids": string[], "rationale": string }`;

    const usr = JSON.stringify({ query, items: condensed });

    let phrases = [];
    let selected_ids = [];

    // ====== モデル呼び出し（JSON 指定はここだけ）======
    try {
      const txt = await callResponses({
        model: "gpt-4o-mini",
        system: sys,
        user: usr,
        temperature: 0.2,
        format: "json",
      });
      const out = JSON.parse(txt || "{}");
      if (Array.isArray(out?.phrases))      phrases = out.phrases.slice(0, 16);
      if (Array.isArray(out?.selected_ids)) selected_ids = out.selected_ids.slice(0, limit).map(String);
    } catch (e) {
      console.warn("[select_articles] model failed:", e?.message || e);
    }

    // ====== フォールバック（簡易キーワード一致）======
    let used_fallback = false;
    if (!selected_ids.length) {
      used_fallback = true;
      const q = query.toLowerCase();
      const tokens = (q.match(/"[^"]+"|[^\s]+/g) || []).map(t => t.replace(/"/g, "").toLowerCase());
      const scored = condensed.map(it => {
        const text = `${it.title} ${it.summary} ${it.source}`.toLowerCase();
        const score = tokens.reduce((a, t) => a + (t && text.includes(t) ? 1 : 0), 0);
        return { id: it.id, score };
      }).sort((a,b) => b.score - a.score)
        .filter(x => x.score > 0)
        .slice(0, limit);
      selected_ids = scored.map(s => s.id);
      if (!phrases.length) phrases = tokens.slice(0, 10);
    }

    return res.json({
      phrases,
      selected_ids,
      _meta: { took_ms: Date.now() - started, used_fallback, engine: "responses", mode: "select" }
    });

  } catch (e) {
    console.error("/api/select_articles fatal:", e);
    // 従来どおり UI を止めないため 200 で空返却
    return res.json({ phrases: [], selected_ids: [], _meta: { fatal: true, used_fallback: true } });
  }
});

const PORT = 8888; // バックエンドは 8888 に固定
app.listen(PORT, () => {
  console.log(`API ready on http://localhost:${PORT}`);
});



