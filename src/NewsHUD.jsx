

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Globe, Newspaper, RefreshCcw } from "lucide-react";
// import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, LabelList } from "recharts";

import {
  ResponsiveContainer, AreaChart, Area,
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, LabelList
} from "recharts";
/* -------------------- Minimal UI (inline) -------------------- */
function cn(...xs){ return xs.filter(Boolean).join(" "); }


// --- Date 正規化ユーティリティ（NewsHUD.jsx の import の下に貼る）---
function toDateSafe(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;

  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // 秒なら×1000
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }

  if (typeof v === "string") {
    let s = v.trim();

    let d = new Date(s);
    if (!isNaN(d)) return d;

    if (/\bJST\b/i.test(s)) {
      d = new Date(s.replace(/JST/i, "+0900"));
      if (!isNaN(d)) return d;
    }

    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      s = s.replace(" ", "T") + "Z";
      d = new Date(s);
      if (!isNaN(d)) return d;
    }

    const n = Number(s);
    if (Number.isFinite(n)) {
      const ms = n < 1e12 ? n * 1000 : n;
      d = new Date(ms);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}

// RSSアイテムから使えそうな日時を拾って Date に
function coerceItemDate(a) {
  const cands = [a?.time, a?.pubDate, a?.published, a?.updated, a?.isoDate, a?.date, a?._ts];
  for (const v of cands) {
    const d = toDateSafe(v);
    if (d) return d;
  }
  return null;
}


function Card({ children, className }) {
  return <div className={cn("rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4 backdrop-blur-xl", className)}>{children}</div>;
}
function CardHeader({ children, className }) {
  return <div className={cn("mb-2 flex items-center justify-between", className)}>{children}</div>;
}
function CardTitle({ children, className }) {
  return <h2 className={cn("text-cyan-100/90 text-sm tracking-wider", className)}>{children}</h2>;
}
function CardContent({ children, className }) {
  return <div className={cn("", className)}>{children}</div>;
}
function Badge({ children, variant="outline", className }) {
  const base = "px-2 py-0.5 text-[10px] rounded border";
  const styles = variant === "outline"
    ? "border-cyan-500/40 text-cyan-200"
    : "bg-cyan-500/20 border-cyan-400/40 text-cyan-100";
  return <span className={cn(base, styles, className)}>{children}</span>;
}
/* ------------------------------------------------------------- */

/* ===== RSS 設定 & ユーティリティ ===== */
const FEEDS = [


    { source: "毎日新聞", url: "https://mainichi.jp/rss/etc/flash.rss" },
  { source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/newsheadlines.rdf" },
  { source: "共同通信", url: "https://www.kyodo.co.jp/feed/" },
  { source: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  // { source: "Reuters World", url: "http://feeds.reuters.com/Reuters/worldNews" },
  { source: "NHK 国際", url: "https://www3.nhk.or.jp/rss/news/cat5.xml" },

  // 2ch 系


  // 日本メディア
  { source: "NHK 国内", url: "https://www3.nhk.or.jp/rss/news/cat0.xml" },
  { source: "読売新聞", url: "https://www.yomiuri.co.jp/rss/yol/all.xml" },
  // { source: "毎日新聞", url: "https://mainichi.jp/rss/etc/flash.rss" },
  // { source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/newsheadlines.rdf" },
  // { source: "共同通信", url: "https://www.kyodo.co.jp/feed/" },

  

//   // 海外メディア
  { source: "CNN Top", url: "http://rss.cnn.com/rss/edition.rss" },
  { source: "NY Times World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { source: "The Guardian World", url: "https://www.theguardian.com/world/rss" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { source: "DW World", url: "https://rss.dw.com/rdf/rss-en-world" },
  { source: "AP News", url: "https://apnews.com/rss" },
];



async function fetchRSSviaProxy(url) {
  // 1st: 自前バックエンド（/api/rss?url=...）で取得（CORS/UA/リトライ制御可）
  try {
    const r1 = await fetch(`/api/rss?url=${encodeURIComponent(url)}`);
    if (r1.ok) return await r1.text(); // そのままXMLテキストを返す
  } catch {}
  // 2nd: Fallback（AllOrigins）。429のときは throw して上位で握りつぶす
  const r2 = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
  if (!r2.ok) throw new Error(`AllOrigins failed: ${url} (${r2.status})`);
  const data = await r2.json();
  return data.contents;
}


function parseRSS(xmlText, fallbackSource) {
   const parser = new DOMParser();
   const xml = parser.parseFromString(xmlText, "application/xml");

 // パース失敗検出
 if (xml.querySelector("parsererror")) return [];

 // RSS2.0 <item> と Atom <entry> の両対応
 const items = [...xml.querySelectorAll("item, entry")];

   const toDate = (s) => {
     if (!s) return null;
     const d = new Date(s);
     return isNaN(d.getTime()) ? null : d;
   };
   const strip = (html) => {
     const tmp = document.createElement("div");
     tmp.innerHTML = html || "";
     return (tmp.textContent || tmp.innerText || "").trim();
   };

   return items.map((node) => {

   const isAtom = node.tagName.toLowerCase() === "entry";
   const title = node.querySelector("title")?.textContent?.trim() || "";
   // link: RSSはテキスト、Atomは <link href="...">
   const link =
     (isAtom
       ? (node.querySelector("link[rel='alternate'][href]")?.getAttribute("href") ||
          node.querySelector("link[href]")?.getAttribute("href"))
       : (node.querySelector("link")?.textContent?.trim())) ||
     node.querySelector("guid")?.textContent?.trim() ||
     "";

   // date: RSS -> pubDate, Atom -> updated or published
   const pubDateRaw =
     (isAtom
       ? (node.querySelector("updated")?.textContent?.trim() ||
          node.querySelector("published")?.textContent?.trim())
       : (node.querySelector("pubDate")?.textContent?.trim())) || "";
     const pubDate = toDate(pubDateRaw);
   const desc =
     node.querySelector("description")?.textContent ||
     node.querySelector("content")?.textContent ||
     node.querySelector("summary")?.textContent ||
     "";
 

   const media =
     node.querySelector("media\\:thumbnail")?.getAttribute("url") ||
     node.querySelector("media\\:content")?.getAttribute("url") ||
     node.querySelector("enclosure[url][type^='image/']")?.getAttribute("url") ||
     (isAtom ? node.querySelector("link[rel='enclosure'][type^='image/']")?.getAttribute("href") : "") ||
     "";

     return {
       title,
       url: link,
       source: fallbackSource,
       time: pubDate ? pubDate.toISOString() : "",
       summary: strip(desc),
       image: media || "",
       _ts: pubDate ? pubDate.getTime() : 0,
       _key: `${title}|${link}`.toLowerCase(),
     };
   }).filter(x => x.title || x.url); // 最低限どちらか無い行は除外
 }


/* ===== メイン ===== */
function toCompactItems(articles = []) {


  return articles.slice(0, 500).map(a => {
    const dt = coerceItemDate(a);            // ← ここで安全化
    return {
      title: a?.title ?? "",
      summary: a?.summary ?? "",
      source: a?.source ?? "",
      time:   dt ? dt.toISOString() : "",    // ← 必ずISOで渡す
      note:   a?.ai ?? a?.note ?? ""
    };
  });
}



function cleanPhrases(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(s => (s || "").toString().trim())
    .filter(Boolean)
    .filter((s, i, a) => s.length >= 3 && a.indexOf(s) === i);
}
function includesAnyKeywordInTitle(title = "", phrases = []) {
  if (!title || !phrases?.length) return false;
  const t = title.toLowerCase();
  return phrases.some(p => t.includes(p.toLowerCase()));
}

export default function NewsHUD() {
  // const [articles, setArticles] = useState([]);
const [allArticles, setAllArticles] = useState([]);
const [articleLimit, setArticleLimit] = useState(() => {
  const v = Number(localStorage.getItem("articleLimit") || 100);
  return Number.isFinite(v) ? v : 100;
});
const [loading, setLoading] = useState(true);




// ★追加: 表示件数でスライスした articles 配列
const articles = React.useMemo(() => {
  return allArticles.slice(0, clamp(articleLimit, 1, 500));
}, [allArticles, articleLimit]);




 const API_BASE = "http://localhost:8000";

async function runForecast({ articles, horizonDays = 14 ,limit }) {
  const payload = {
    items: toCompactItems(articles),
        horizonDays,
       // limit が未指定なら選別記事数で送る（上限 500 に安全化）
       limit: Number.isFinite(limit) ? Math.min(Math.max(1, limit), 500) : Math.min(articles?.length || 0, 500)
  };

  const res = await fetch("/api/forecast" , {
    // const res = await fetch(`${API_BASE}/api/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), // ← ここに articles を直接入れない
  });

  const text = await res.text();            // まず text で受ける（400/502でも読める）
  if (!res.ok) {
    throw new Error(`Forecast API ${res.status}: ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Forecast API 非JSON応答: ${text}`);
  }
  return json;
}

async function runForecast2({ articles, horizonDays = 14 }) {

  console.log("phrases =", articles);
  const payload = {
    items: toCompactItems(articles),
    horizonDays
    };

  // const res = await fetch("/api/forecast" , {
    const res = await fetch(`${API_BASE}/api/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), // ← ここに articles を直接入れない
  });

  console.log("phrases =", res);



  const text = await res.text();            // まず text で受ける（400/502でも読める）
  if (!res.ok) {
    throw new Error(`Forecast API ${res.status}: ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Forecast API 非JSON応答: ${text}`);
  }
  return json;
}


function getArticleId(a, i) {
  // server.js に渡した id と一致するように安定キーを作る
  return String(a?._key || `${a.source || "src"}|${a.title || ""}|${a.url || ""}|${i}`);
}

async function selectByAIAndForecast() {
  try {
    // 送信用に軽量化 + id 付与
    const items = articles.map((a, i) => {
      const dt = coerceItemDate(a);
      return {
        id: getArticleId(a, i),
        title: a.title || "",
        summary: a.summary || "",
        source: a.source || "",
        time: dt ? dt.toISOString() : ""
      };
    });

    const res = await fetch("/api/select_articles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, items, limit: 200 })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || res.status);

    // const ids = new Set((json.selected_ids || []).map(String));
    // setLastPhrases(Array.isArray(json.phrases) ? json.phrases : []);

    // // クライアント側 articles から抽出
    // const selected = articles.filter((a, i) => ids.has(getArticleId(a, i)));

    // // Node 版のフォーキャストへ（FastAPIにも切替可）
    // await handleRunForecast({ articles: selected });

        const rawPhrases = Array.isArray(json.phrases) ? json.phrases : [];
    // const phrases = cleanPhrases(rawPhrases);
    // setLastPhrases(phrases);

    // ① まず「キーワードをタイトルに含む記事」だけに絞る
    // let selected = articles.filter(a => includesAnyKeywordInTitle(a.title, phrases));

    // ② もし①が0件なら、従来どおり selected_ids で抽出
  //   if (selected.length === 0) {
  //     const ids = new Set((json.selected_ids || []).map(String));
  //     selected = articles.filter((a, i) => ids.has(getArticleId(a, i)));
  //   }

  //   // ③ それでも空なら最後の保険：全部（現状表示分）
  //   if (selected.length === 0) selected = articles;

  //   // 送信（Node版フォーキャスト）
  //  await handleRunForecast({ articles: selected });

   const phrases = cleanPhrases(Array.isArray(json.phrases) ? json.phrases : []);
 setLastPhrases(phrases);

 
 let selected = articles.filter(a => includesAnyKeywordInTitle(a.title, phrases));
 if (selected.length === 0) { // フォールバック：selected_ids
  console.log("phrases =", phrases);
console.log("selected(by title) =", selected.length);
   const ids = new Set((json.selected_ids || []).map(String));
   selected = articles.filter((a, i) => ids.has(getArticleId(a, i)));
 }
 console.log("phrases =", phrases);
console.log("selected(by title) =", selected.length);
 if (selected.length === 0) selected = articles; // 最後の保険
 await handleRunForecast({ articles: selected, limit: selected.length });
  } catch (e) {
    console.error("selectByAIAndForecast error:", e);
    alert("AI選別に失敗しました: " + String(e?.message || e));
  }
}


  const [forecast, setForecast] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const MAX_SEND = 500;

const [forecastSource, setForecastSource] = useState(null); // 'node' | 'fastapi' | null
const isFastAPI = forecastSource === "fastapi";

const loadAll = async () => {
    setLoading(true);
    try {
      // 複数RSSを並列取得 → パース
           const xmls = await Promise.all(
         FEEDS.map(async (f) => {
           try {
             const xmlText = await fetchRSSviaProxy(f.url);

               console.log("[RSS] news:", xmlText);

             return parseRSS(xmlText, f.source);
           } catch (e) {
             console.warn("RSS fetch failed:", f.source, e);
             return [];
           }
         })
       );


     const merged = xmls.flat().filter(Boolean);
      if (merged.length === 0) {
        console.warn("No valid RSS entries. Check feeds/proxy.");
      }
 
      const dedupMap = new Map();
      for (const it of merged) {
        if (!dedupMap.has(it._key)) dedupMap.set(it._key, it);
      }
      // const list = [...dedupMap.values()]
      //   .sort((a, b) => (b._ts || 0) - (a._ts || 0))
      //   .slice(0, 100);

const list = [...dedupMap.values()]
  .sort((a, b) => (b._ts || 0) - (a._ts || 0));
// .slice(0, 100) ← 削除

setAllArticles(list);   // 変更
// setArticles(list);   // 削除
        
      // setArticles(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

const handleRunForecast = async ({ articles: arts, horizonDays = 14, limit } = {}) => {
// const handleRunForecast = async ({ articles, horizonDays = 14, limit } = {}) => {
  try {
    setForecastLoading(true);
    setForecastSource("node");

  

        // 引数が無ければ現在の articles を使う
    const useArticles = Array.isArray(arts) ? arts : (Array.isArray(articles) ? articles : []);
    if (!useArticles.length) {
      console.warn("[forecast] no articles to send");
      setForecast({ error: "フォーキャスト用の記事が0件です（タイトル一致が0件でした）。" });
      return; // ★ 0件なら送信しない
    }
    const effLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : useArticles.length;
   const data = await runForecast({ articles: useArticles, horizonDays, limit: effLimit })

    setForecast(data);
  } catch (e) {
    setForecast({ error: `フォーキャスト生成に失敗: ${String(e?.message || e)}` });
  } finally {
    setForecastLoading(false);
  }
};

 const handleRunForecast2 = async () => {
   try {
     setForecastLoading(true);
         setForecastSource("fastapi");        // 追加
     const data = await runForecast2({ articles, horizonDays: 14 });
     setForecast(data);
   } catch (e) {
     setForecast({ error: `フォーキャスト生成に失敗: ${String(e?.message || e)}` });
   } finally {
     setForecastLoading(false);
   }
 };


 const [query, setQuery] = useState("");
const [lastPhrases, setLastPhrases] = useState([]);

  return (
    <div className="relative min-h-screen w-full bg-black text-cyan-100 overflow-hidden">
      <HUDGrid />

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <Newspaper className="h-5 w-5 text-cyan-300" />
          <span className="tracking-widest text-cyan-200/90">J.A.R.V.I.S. // NEWS FEED</span>
          <Badge variant="outline">{loading ? "LOADING" : "LIVE"}</Badge>
        </div>



         <div className="flex items-center gap-3">

         <input
  type="text"
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  placeholder={`自然言語で指示（例: 中東の停戦交渉を中心に直近48hを重視）`}
  className="w-[32rem] rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-sm text-cyan-100 outline-none focus:border-cyan-300"
/>
<button
  className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs hover:bg-emerald-400/20"
  title="AIが必要フレーズを抽出し、一致カードのみNode予測に送信"
  onClick={selectByAIAndForecast}
>
  AIで抽出 → 予測
</button>

{lastPhrases.length ? (
  <div className="text-[11px] text-cyan-200/70">
    抽出フレーズ: {lastPhrases.join(" / ")}
  </div>
) : null}
    <label className="text-xs text-cyan-200/80">
      表示件数
    </label>
    <input
      type="number"
      min={1}
      max={500}
      value={articleLimit}
      onChange={(e) => {
        const v = Number(e.target.value);
        setArticleLimit(Number.isFinite(v) ? v : 100);
      }}
      className="w-20 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-sm text-cyan-100 outline-none focus:border-cyan-300"
      title="1〜500 の範囲で指定"
    />
    <div className="flex items-center gap-6 text-cyan-200/80">
      <div className="flex items-center gap-2"><Globe className="h-4 w-4" /><span>WORLDWIDE</span></div>
      <RefreshCcw
        className="h-4 w-4 cursor-pointer hover:text-cyan-100"
        onClick={loadAll}
        title="Refresh"
      />
    </div>
  </div>
</div>

      {/* Calculus / DS block */}

      <CalculusOverview
        articles={articles}
        loading={loading}
        forecast={forecast}
        forecastLoading={forecastLoading}
        // runForecast={runForecast}
         runForecast={handleRunForecast}
         runForecast2={handleRunForecast2}
         hideNarrative={isFastAPI}   // ★ 追加：FastAPIのときだけ非表示に

     />     
    

    
      {/* News List */}

<div className="relative z-10 grid lg:grid-cols-2 gap-6 px-6 pb-8">
  {loading ? (
    <div className="text-center col-span-2 text-cyan-400">Loading news...</div>
  ) : (
    articles.map((a, i) => (
      <motion.div
        key={a._key ?? `${a.source ?? "src"}-${i}`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(i * 0.04, 0.6) }}
      >
        <GlassCard title={a.title}>
          {a.image ? (
            <img
              src={a.image}
              alt=""
              className="mb-2 rounded-lg max-h-40 w-full object-cover opacity-90"
            />
          ) : null}

          <div className="text-sm text-cyan-200/90 mb-2 line-clamp-3">
            {a.summary}
          </div>

          {/* AI解説（あれば表示） */}
          {a.aiLoading ? (
            <div className="text-xs text-cyan-300/80 mb-2">AI解説を生成中…</div>
          ) : a.ai ? (
            <div className="text-xs text-cyan-200/80 mb-2">{a.ai}</div>
          ) : null}

          <div className="flex justify-between items-center text-xs text-cyan-400/70">
            <span>{a.source}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="underline hover:text-cyan-200"
                title="OpenAIにタイトルを投げて要約を追記"
                onClick={async () => {
                  setAllArticles(prev =>
                    prev.map(x =>
                      (x._key ?? `${x.source ?? "src"}-${i}`) === (a._key ?? `${a.source ?? "src"}-${i}`)
                        ? { ...x, aiLoading: true }
                        : x
                    )
                  );
                  try {
                    const note = await annotateTitle(a.title, { source: a.source, time: a.time, summary: a.summary });
                    setAllArticles(prev =>
                      prev.map(x =>
                        (x._key ?? `${x.source ?? "src"}-${i}`) === (a._key ?? `${a.source ?? "src"}-${i}`)
                          ? { ...x, ai: note, aiLoading: false }
                          : x
                      )
                    );
                  } catch (e) {
                    setAllArticles(prev =>
                      prev.map(x =>
                        (x._key ?? `${x.source ?? "src"}-${i}`) === (a._key ?? `${a.source ?? "src"}-${i}`)
                          ? { ...x, ai: "AI解説の取得に失敗しました。", aiLoading: false }
                          : x
                      )
                    );
                  }
                }}
              >
                AI解説
              </button>

              {a.url ? (
                <a
                  className="underline hover:text-cyan-200"
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open
                </a>
              ) : (
                <span>{a.time}</span>
              )}
            </div>
          </div>
        </GlassCard>
      </motion.div>
    ))
  )}
</div>
</div>

);
}



function HUDGrid() {
  return (
    <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]">
      <div className="absolute inset-0 opacity-20">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(56,189,248,0.1) 1px, transparent 1px), linear-gradient(to bottom, rgba(56,189,248,0.08) 1px, transparent 1px)",
            backgroundSize: "40px 40px, 40px 40px",
          }}
        />
      </div>
    </div>
  );
}

function GlassCard({ title, children }) {
  return (
    <Card className="shadow-[0_0_40px_rgba(34,211,238,0.08)]">
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/* ================== Calculus & DS Extensions ================== */
function diff(series) {
  const d = [];
  for (let i = 1; i < series.length; i++) d.push(series[i] - series[i - 1]);
  return d;
}
function integrate(series) {
  let area = 0;
  for (let i = 1; i < series.length; i++) area += (series[i] + series[i - 1]) / 2;
  return area;
}
function movingAvg(series, k = 5) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const s = Math.max(0, i - k + 1);
    const slice = series.slice(s, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function useSimSeries(seed = 0, len = 120) {
  const [series, setSeries] = React.useState(
    Array.from({ length: len }, (_, i) =>
      50 + 10 * Math.sin((i + seed) / 5) + 8 * Math.cos((i + seed) / 9) + 6 * Math.random()
    )
  );
  React.useEffect(() => {
    const id = setInterval(() => {
      setSeries((prev) => {
        const i = prev.length;
        const next = 50 + 10 * Math.sin((i + seed) / 5) + 8 * Math.cos((i + seed) / 9) + 6 * Math.random();
        const arr = [...prev.slice(1), clamp(next, 0, 120)];
        return arr;
      });
    }, 1200);
    return () => clearInterval(id);
  }, [seed]);
  return series;
}

function sparkColor(slope) { return slope > 0 ? "#22d3ee" : "#f472b6"; }



function Metric({ label, value, unit, color, note }) {
return (
<div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-2">
<div className="opacity-70 text-[10px]">{label}</div>
<div className="text-cyan-100 font-mono">
<span style={{ color: color || undefined }}>{value}</span>
{unit ? <span className="opacity-70 ml-1">{unit}</span> : null}
</div>
{note ? (
<div className="text-[10px] mt-1 text-cyan-200/80">{note}</div>
) : null}
</div>
);
}




const aiCache = new Map(); // title をキーにキャッシュ
async function annotateTitle(title, { source, time, summary } = {}) {
  // 既に取得済みならキャッシュを返す
  if (aiCache.has(title)) return aiCache.get(title);

  const res = await fetch("/api/annotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      // あると精度が上がるのでメタも渡す（サーバ側は title だけでもOK）
      meta: { source, time, summary }
    }),
  });

  if (!res.ok) {
    throw new Error(`annotate failed: ${res.status}`);
  }
  const { note } = await res.json(); // { note: "..." }
  aiCache.set(title, note);
  return note;
}

function pickDerivativeIndex(series) {
  const n = series.length;
  if (n === 0) return -1;
  if (n === 1) return 0;
  if (n === 2) return 1;

  // まずは中央差分が可能な領域 [1 .. n-2] で、末尾側から有効な点を探す
  for (let i = n - 2; i >= 1; i--) {
    const left = series[i - 1], cur = series[i], right = series[i + 1];
    // 近傍のいずれかに変化があれば「有効」とみなす
    if ((left?.V ?? 0) !== (cur?.V ?? 0) || (right?.V ?? 0) !== (cur?.V ?? 0)) {
      return i;
    }
  }
  // すべてフラットなら末尾-1（中央差分が取れる端）にフォールバック
  return n - 2;
}

// function CalculusOverview({ articles, loading, forecast, forecastLoading, runForecast ,runForecast2 }) {  // 30分ビン
function CalculusOverview({ articles, loading, forecast, forecastLoading, runForecast, runForecast2, hideNarrative }) {
  const BIN_MIN = 30;

  // --- 既存の時系列（総露出・傾き・加速度） ---
  const series = React.useMemo(
    () => buildTimeSeries(articles, { binMs: BIN_MIN * 60_000 }),
    [articles]
  );

  const hasSeries = series.length > 0;
  const exposure = hasSeries ? series[series.length - 1].exposure : 0;

  // dV/dt・d²V/dt²の代表点（末尾側で中央差分が取れる点）
  const didx = pickDerivativeIndex(series);
  const dpoint = didx >= 0 ? series[didx] : undefined;

  const slopePerHour  = dpoint ? (dpoint.slope  ?? 0) * 60      : 0;  // /min → /h
  const accelPerHour2 = dpoint ? (dpoint.accel ?? 0) * 60 * 60 : 0;  // /min² → /h²

    const avgSlope = series.length > 0
    ? series.reduce((a, s) => a + (s.slope || 0), 0) / series.length * 60
    : 0;

  const avgAccel = series.length > 0
    ? series.reduce((a, s) => a + (s.accel || 0), 0) / series.length * 60 * 60
    : 0;

  // 左側エリアチャート用：各ビンの記事数
  const binHours   = BIN_MIN / 60;
  const binCounts  = series.map(s => s.V);
  const rateSeries = series.map(s => (s.V / binHours));
  const d          = diff(rateSeries); // 参考：レート差分


  const labeledSeries = React.useMemo(() => {
  const toKeywords = (title = "") => {
    const toks = (title.toLowerCase().match(/[a-zA-Z0-9]+/g) || [])
      .filter(w => w.length >= 3 && ![
        "the","and","for","with","from","that","this","was","are","you",
        "your","our","nhk","bbc","reuters"
      ].includes(w));
    return toks.slice(0, 3);
  };

  // ★★ ここで CC（coerceItemDate） を使って “必ず有効な ISO文字列” にして渡す ★★
  let skipped = 0;
  const items = (articles || []).map(a => {
    const dt = coerceItemDate(a);
    if (!dt) { skipped++; return null; }
    return {
      time: dt.toISOString(),   // ← ここを a.time ではなく安全化した ISO に
      value: 1,
      keywords: toKeywords(a.title || "")
    };
  }).filter(Boolean);

  if (skipped) console.warn("[RSS] skipped invalid-date items:", skipped);

  // あなたの buildSeriesWithLabels の想定にそのまま合わせる
  return buildSeriesWithLabels(items, { threshold: 3 });
}, [articles]);


  // デバッグログ
  console.log("[RSS] series:", series);
  console.log("[RSS] exposure:", exposure, "(min-weighted)");
  console.log("[RSS] slope idx:", didx, "value (/h):", slopePerHour);
  console.log("[RSS] accel idx:", didx, "value (/h^2):", accelPerHour2);
  console.log("[RSS] labeledSeries:", labeledSeries);

var [forecastSource, setForecastSource] = useState(null); // 'node' | 'fastapi' | null
var isFastAPI = forecastSource === "fastapi";

  return (
    <div className="relative z-10 px-6 pb-4">
      <Card>
         <CardHeader className="pb-2 flex items-center justify-between">
          <CardTitle className="text-cyan-100/90 tracking-wider text-sm">
            CALCULUS OVERVIEW
          </CardTitle>
   {/* 右側を1コンテナにまとめ、gapで制御 */}
   <div className="flex items-center gap-2 sm:gap-2.5">
     <button
       onClick={runForecast}
       className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-3 py-1 text-xs hover:bg-cyan-400/20"
       title="表示中(上限500)の記事＋noteをOpenAIに送り近未来予測を生成"
     >
       総合予測 (7–14日)
     </button>
     <button
       onClick={runForecast2}
       className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs hover:bg-emerald-400/20"
       title="FastAPI(8000) を直接叩いて予測 → グラフにも反映"
     >
       ARIMA, Poisson回帰,ベイズ推定,ネットワーク・グラフ解析
     </button>
   </div>


        </CardHeader>
        <CardContent>
<div className="grid md:grid-cols-4 gap-3">
  <Metric
    label="総露出 ∫V dt（分重み）"
    value={Math.round(exposure)}
    note={describeExposure(exposure)}
  />
  <Metric
    label="傾き dV/dt"
    value={slopePerHour.toFixed(2)}
    unit="/h"
    color={sparkColor(slopePerHour)}
    note={describeSlope(slopePerHour)}
  />
  <Metric
    label="加速度 d²V/dt²"
    value={accelPerHour2.toFixed(2)}
    unit="/h²"
    color={sparkColor(accelPerHour2)}
    note={describeAccel(accelPerHour2)}
  />
  <Metric
    label="記事数"
    value={loading ? "-" : String(articles.length)}
    note={!loading ? describeCount(articles.length) : "読み込み中"}
  />
  <Metric
    label="平均傾き dV/dt"
    value={avgSlope.toFixed(2)}
    unit="/h"
    color={sparkColor(avgSlope)}
    note={describeAvgSlope(avgSlope)}
  />
  <Metric
    label="平均加速度 d²V/dt²"
    value={avgAccel.toFixed(2)}
    unit="/h²"
    color={sparkColor(avgAccel)}
    note={describeAvgAccel(avgAccel)}
  />
</div>
          


          <div className="mt-3 grid lg:grid-cols-2 gap-3">
            {/* 左：記事数(ビン)の推移（既存のエリアチャート） */}
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={binCounts.map((v, i) => ({ t: i, v }))}
                  margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                >
                  <CartesianGrid strokeOpacity={0.08} strokeDasharray="3 3" />
                  <XAxis dataKey="t" hide />
                  <YAxis hide />
                  <Tooltip />
                  <Area type="monotone" dataKey="v" stroke="#22d3ee" strokeWidth={2} fill="#22d3ee22" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* 右：キーワード注釈つきラインチャート（スパイク点のみ表示） */}
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={labeledSeries}
                  margin={{ top: 8, right: 8, left: -10, bottom: 0 }}
                >
                  <CartesianGrid strokeOpacity={0.08} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit" })}
                  />
                  <YAxis hide />
                  <Tooltip
                    labelFormatter={(t) => new Date(t).toLocaleString()}
                    formatter={(v, _name, ctx) => {
                      // ツールチップでラベル（トップキーワード）を一緒に表示
                      const lbl = ctx?.payload?.label || "";
                      return [v, lbl ? `Top: ${lbl}` : "Value"];
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    dot={false}
                    stroke="#67e8f9"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    <LabelList
                      dataKey="label"
                      position="top"
                      offset={12}
                      className="fill-cyan-300"
                      style={{ fontSize: 12, fontWeight: 600 }}
                    />
                  </Line>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

             {/* ▼▼▼ Forecast 結果をカード内に埋め込み ▼▼▼ */}
             
  {forecastLoading ? (
  <div className="mt-4 text-cyan-300">総合予測を生成中…</div>
) : forecast ? (
  <div className="mt-4">
    <GlassCard title="WORLD FORECAST (近未来 7–14日)">
      {/* 画像 3 枚のブロック */}
      <div className="mt-3 grid lg:grid-cols-3 gap-8">
        <div>
          <div className="text-xs mb-1 opacity-80">Regional Lines</div>
          <img
            src={`http://localhost:8000/api/plot/regional_lines?ts=${Date.now()}`}
            alt="regional lines"
            className="rounded-lg border border-cyan-400/20"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.retried) {
                img.dataset.retried = "1";
                setTimeout(() => {
                  img.src = `http://localhost:8000/api/plot/regional_lines?ts=${Date.now()}`;
                }, 800);
              } else {
                img.src = `data:image/svg+xml;utf8,` +
                  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="100%" height="100%" fill="transparent"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#88d" font-size="14">No regional data</text></svg>');
              }
            }}
          />
        </div>
        <div>
          <div className="text-xs mb-1 opacity-80">Spike Risk (Poisson)</div>
          <img
            src={`http://localhost:8000/api/plot/risk_bars?ts=${Date.now()}`}
            alt="risk bars"
            className="rounded-lg border border-cyan-400/20"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.retried) {
                img.dataset.retried = "1";
                setTimeout(() => {
                  img.src = `http://localhost:8000/api/plot/risk_bars?ts=${Date.now()}`;
                }, 800);
              } else {
                img.src = `data:image/svg+xml;utf8,` +
                  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="100%" height="100%" fill="transparent"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#88d" font-size="14">No regional data</text></svg>');
              }
            }}
          />
        </div>
        <div>
          <div className="text-xs mb-1 opacity-80">Co-occurrence Network</div>
          <img
            src={`http://localhost:8000/api/plot/cooccurrence?ts=${Date.now()}`}
            alt="cooccurrence graph"
            className="rounded-lg border border-cyan-400/20"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.retried) {
                img.dataset.retried = "1";
                setTimeout(() => {
                  img.src = `http://localhost:8000/api/plot/cooccurrence?ts=${Date.now()}`;
                }, 800);
              } else {
                img.src = `data:image/svg+xml;utf8,` +
                  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="100%" height="100%" fill="transparent"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#88d" font-size="14">No regional data</text></svg>');
              }
            }}
          />
        </div>
      </div>

      {/* ▼ FastAPI 直呼び時はここを非表示 */}
      {!hideNarrative && (
        <>
          {forecast.error ? (
            <div className="text-rose-300">{forecast.error}</div>
          ) : (
            <div className="space-y-3 text-sm text-cyan-100/90">
              <div className="opacity-80">
                生成日時(JST): {forecast.as_of_jst} / カバレッジ: {forecast.coverage_count}
              </div>
              <div>
                <div className="font-semibold">Top Themes</div>
                <ul className="list-disc ml-5">
                  {(forecast.top_themes || []).map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>

              {/* Signals */}
              <div>
                <div className="font-semibold">Signals</div>
                {!(forecast.signals && forecast.signals.length) ? (
                  <div className="opacity-80">なし</div>
                ) : (
                  <ul className="list-disc ml-5 space-y-1">
                    {forecast.signals.map((s, i) => (
                      <li key={i}>
                        <div className="font-semibold">{s.headline}</div>
                        <div className="opacity-90">{s.why_it_matters}</div>
                        <div className="opacity-70">
                          {s.region ? `Region: ${s.region} / ` : ""}
                          {typeof s.confidence === "number" ? `Confidence: ${s.confidence}` : ""}
                          {typeof s.window_days === "number" ? ` / Window: ${s.window_days}d` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Scenarios */}
              <div>
                <div className="font-semibold">Scenarios (7–14d)</div>
                <ul className="list-disc ml-5 space-y-1">
                  {(forecast.scenarios_7_14d || []).map((sc, i) => (
                    <li key={i}>
                      <span className="font-semibold">{sc.name}</span> — {sc.description}
                      {typeof sc.probability === "number" ? ` (p≈${Math.round(sc.probability*100)}%)` : ""}
                      {Array.isArray(sc.triggers) && sc.triggers.length ? (
                        <div className="opacity-80">Triggers: {sc.triggers.join(", ")}</div>
                      ) : null}
                      {Array.isArray(sc.watchlist) && sc.watchlist.length ? (
                        <div className="opacity-80">Watchlist: {sc.watchlist.join(", ")}</div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Gaia */}
              {forecast.gaia_lens ? (
                <div>
                  <div className="font-semibold">Gaia Lens（地球システム）</div>
                  <div>Climate signals: {(forecast.gaia_lens.climate_signals || []).join(" / ")}</div>
                  <div>Environmental risks: {(forecast.gaia_lens.environmental_risks || []).join(" / ")}</div>
                  <div className="opacity-80">{forecast.gaia_lens.note}</div>
                </div>
              ) : null}

              {/* Horoscope */}
              {forecast.horoscope_narrative ? (
                <div>
                  <div className="font-semibold">Horoscope-style（占星術）</div>
                  <div className="opacity-90">{forecast.horoscope_narrative}</div>
                </div>
              ) : null}

              <div className="opacity-80">
                Caveats: {forecast.caveats || "This is a speculative synthesis of headlines/notes only."}
              </div>

              {typeof forecast.confidence_overall === "number" ? (
                <div className="opacity-80">Overall confidence: {Math.round(forecast.confidence_overall * 100)}%</div>
              ) : null}
            </div>
          )}
        </>
      )}
    </GlassCard>
  </div>
) : null}
         {/* ▲▲▲ ここまで Forecast ▲▲▲ */}

        </CardContent>
      </Card>
      
    </div>
    
  );
}




// ─── ADD: helpers (place ABOVE CalculusOverview) ──────────────────────────────
/** Parse to ms */
const toMs = (t) => (typeof t === "string" ? Date.parse(t) : +t);

/** Round a date to minute for binning */
const floorToMinute = (d) => {
  const x = new Date(d);
  x.setSeconds(0, 0);
  return x.getTime();
};

/**
 * Build a regular time series from RSS items and compute:
 *  V: value per bin (article count)
 *  ∫V dt: exposure (trapezoid cumulative integral, minutes as time unit)
 *  dV/dt: slope (per min, central difference)
 *  d²V/dt²: accel (per min²)
 */
function buildTimeSeries(items, { binMs = 60_000 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // 1) bin counts per minute
  const bins = new Map();
  for (const it of items) {
    if (!it || !it.time) continue;
    const t = floorToMinute(toMs(it.time));
    bins.set(t, (bins.get(t) || 0) + 1);
  }

  // 2) create dense timeline from min..max (no gaps)
  const times = [...bins.keys()].sort((a, b) => a - b);
  const t0 = times[0];
  const tN = times[times.length - 1];
  const series = [];
  for (let t = t0; t <= tN; t += binMs) {
    const V = bins.get(t) || 0;
    series.push({ t, V });
  }

  // 3) integral (trapezoid), slope, accel
  let exposure = 0;
  for (let i = 0; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (i > 0) {
      const dtMin = (cur.t - prev.t) / 60_000; // minutes
      exposure += ((prev.V + cur.V) / 2) * dtMin;
    }
    // slope (central diff where possible; fallback to forward/backward)
    const left = series[i - 1];
    const right = series[i + 1];
    let dVdt = 0;
    if (left && right) dVdt = (right.V - left.V) / (2 * (binMs / 60_000));
    else if (right) dVdt = (right.V - cur.V) / (binMs / 60_000);
    else if (left) dVdt = (cur.V - left.V) / (binMs / 60_000);

    // accel (second diff)
    let d2Vdt2 = 0;
    if (left && right) {
      d2Vdt2 =
        (right.V - 2 * cur.V + left.V) /
        Math.pow(binMs / 60_000, 2); // per min^2
    }
series[i] = {
      ...cur,
      exposure, // ∫V dt
      slope: dVdt, // dV/dt
      accel: d2Vdt2, // d²V/dt²
      date: new Date(cur.t).toISOString(),
    };
  }

  return series;
}


class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, msg: "" };
  }
  static getDerivedStateFromError(err) {
    return { hasError: true, msg: err?.message || String(err) };
  }
  componentDidCatch(err, info) {
    console.error("UI ErrorBoundary:", err, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-200">
          <div className="font-semibold">計算モジュールでエラーが発生しました</div>
          <div className="text-xs opacity-80">{this.state.msg}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── helpers for keyword labels (クラスの外！) ─────────────────────────
function bucketHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function buildSeriesWithLabels(items, { threshold = 3 } = {}) {
  const buckets = new Map();
  for (const it of items ?? []) {
    const key = bucketHour(it.time);
    const b = buckets.get(key) || { time: key, value: 0, kwCounts: {} };
    b.value += Number(it.value ?? 0);
    for (const kw of it.keywords ?? []) {
      if (!kw) continue;
      b.kwCounts[kw] = (b.kwCounts[kw] || 0) + 1;
    }
    buckets.set(key, b);
  }

  const series = Array.from(buckets.values()).sort(
    (a, b) => new Date(a.time) - new Date(b.time)
  );

  return series.map((p, i, arr) => {
    const prev = arr[i - 1]?.value ?? p.value;
    const next = arr[i + 1]?.value ?? p.value;
    const isSpike = p.value >= threshold && p.value >= prev && p.value >= next;

    const topKeyword =
      Object.entries(p.kwCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

    return { time: p.time, value: p.value, label: isSpike ? topKeyword : "" };
  });
}


function describeExposure(exposure) {
if (exposure >= 1000) return "露出が非常に大きい（長時間・大量）";
if (exposure >= 300) return "露出は多め";
if (exposure >= 100) return "露出は中程度";
return "露出は限定的";
}


function describeSlope(slopePerHour) {
if (slopePerHour >= 0.50) return "記事数が急増している（注文度高い）";
if (slopePerHour >= 0.10) return "緩やかな増加";
if (slopePerHour > -0.10) return "ほぼ横ばい（±0.10/h 以内）";
if (slopePerHour > -0.50) return "緩やかな減少";
return "減少が強まっている";
}


function describeAccel(accelPerHour2) {
if (accelPerHour2 >= 1.00) return "ニュースが急加速している";
if (accelPerHour2 >= 0.20) return "加速傾向";
if (accelPerHour2 > -0.20) return "勢いは安定（±0.20/h² 以内）";
if (accelPerHour2 > -1.00) return "鈍化傾向";
return "勢いの減速が強い";
}


function describeCount(n) {
if (n >= 100) return "ニュースが集中して発生";
if (n >= 30) return "多め";
if (n >= 10) return "やや少なめ";
return "限定的";
}


function describeAvgSlope(avgSlope) {
if (avgSlope >= 0.20) return "全体的に右肩上がり";
if (avgSlope <= -0.20) return "全体的に減少傾向";
return "大きな変化なし";
}


function describeAvgAccel(avgAccel) {
if (avgAccel >= 0.50) return "全体的に勢いが増している";
if (avgAccel <= -0.50) return "全体的に落ち着きつつある";
return "ほぼ安定";
}