from fastapi import FastAPI, Request
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
from dateutil import parser as dtparser
import pytz
import numpy as np
import pandas as pd
from collections import Counter, defaultdict


# Stats / ML
from statsmodels.tsa.arima.model import ARIMA
from sklearn.linear_model import PoissonRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans
import networkx as nx
from fastapi.responses import StreamingResponse
import httpx
from fastapi.responses import PlainTextResponse
import io, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from fastapi.middleware.cors import CORSMiddleware


import matplotlib.dates as mdates

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5175"],  # ViteのOrigin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 直近の items をキャッシュ（/api/forecast 呼び出し時に更新）


_LAST_ITEMS: list["Item"] = []



# ---------- Pydantic ----------
class Item(BaseModel):
    title: Optional[str] = ""
    summary: Optional[str] = ""
    source: Optional[str] = ""
    time: Optional[str] = ""      # ISO文字列想定
    note: Optional[str] = ""

class ForecastReq(BaseModel):
    items: List[Item]
    horizonDays: int = Field(default=14, ge=1, le=30)

# ---------- Helpers ----------
JST = pytz.timezone("Asia/Tokyo")

COUNTRY_KEYWORDS = {
    # 超簡易辞書（必要に応じて拡充）
    "Japan": ["Japan", "日本", "Tokyo", "東京", "NHK"],
    "China": ["China", "中国", "Beijing", "北京"],
    "USA":   ["United States", "US ", "USA", "America", "米国", "Washington"],
    "Russia":["Russia", "ロシア", "Moscow", "モスクワ"],
    "Ukraine":["Ukraine","ウクライナ","Kyiv","キーウ"],
    "Israel":["Israel","イスラエル","Tel Aviv","テルアビブ","Gaza","ガザ"],
    "Iran":  ["Iran","イラン","Tehran","テヘラン"],
    "EU":    ["EU","European Union","欧州連合","Brussels","ブリュッセル"],
}

TOPIC_MAP = {
    "地政学リスク": ["missile","attack","border","軍","紛争","衝突","戦闘","占拠","爆発","制裁"],
    "経済危機": ["recession","inflation","失業","破綻","債務","金利上昇","通貨安","default"],
    "災害": ["earthquake","台風","flood","津波","wildfire","heatwave","干ばつ","噴火"],
}

def now_jst_str():
    return datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

def safe_parse_time(s: str) -> Optional[datetime]:
    if not s: return None
    try:
        dt = dtparser.parse(s)
        if dt.tzinfo is None:
            # 無指定はUTC想定 → JSTへ
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(JST)
    except Exception:
        return None

def pick_region(text: str) -> Optional[str]:
    if not text: return None
    for region, kws in COUNTRY_KEYWORDS.items():
        for kw in kws:
            if kw.lower() in text.lower():
                return region
    return None

def minute_bin(dt: datetime, size_min: int=60) -> datetime:
    # size_min=60 → 1時間ビン
    dt2 = dt.replace(minute=0, second=0, microsecond=0)
    offset = (dt.minute // size_min) * size_min
    return dt2 + timedelta(minutes=offset)

def build_region_series(items: List[Item], bin_min=60):
    """地域ごとに時系列（各ビンの件数）を辞書で返す"""
    buckets = defaultdict(lambda: Counter())
    for it in items:
        t = safe_parse_time(it.time)
        if not t: continue
        text = f"{it.title or ''} {it.summary or ''} {it.note or ''}"
        region = pick_region(text) or "Unknown"
        b = minute_bin(t, bin_min)
        buckets[region][b] += 1
    # 時系列生成
    series = {}
    for region, ctr in buckets.items():
        if not ctr: 
            continue
        times = sorted(ctr.keys())
        t0, tN = times[0], times[-1]
        ts, vals = [], []
        cur = t0
        while cur <= tN:
            ts.append(cur)
            vals.append(ctr.get(cur, 0))
            cur += timedelta(minutes=bin_min)
        series[region] = (ts, np.array(vals, dtype=float))
    return series

def arima_forecast(y: np.ndarray, steps: int=24):
    # 短系列に強い安全運用（例外は None 返し）
    if y is None or len(y) < 8 or np.allclose(y, 0):
        return None
    try:
        model = ARIMA(y, order=(1,1,1))
        res = model.fit(method_kwargs={"warn_convergence": False})
        fc = res.forecast(steps=steps)
        # マイナス防止
        fc = np.clip(fc, 0, None)
        return float(np.mean(fc))
    except Exception:
        return None

def poisson_risk(y: np.ndarray):
    """直近ウィンドウから次ビンをPoisson回帰で予測→現在比をrisk_scoreに"""
    if y is None or len(y) < 10 or np.sum(y) == 0:
        return None
    try:
        # 簡易特徴: 過去k個の移動平均・傾き
        k = min(6, len(y)//2)
        X = []
        for i in range(k, len(y)):
            window = y[i-k:i]
            mean = window.mean()
            slope = (window[-1] - window[0]) / max(1, k-1)
            X.append([mean, slope])
        X = np.array(X)
        y_trg = y[k:]
        model = PoissonRegressor(alpha=1e-3, max_iter=300)
        model.fit(X, y_trg)
        # 次ビン特徴
        last_window = y[-k:]
        mean = last_window.mean()
        slope = (last_window[-1] - last_window[0]) / max(1, k-1)
        yhat_next = model.predict(np.array([[mean, slope]]))[0]
        yhat_next = max(0.0, float(yhat_next))
        base = max(1e-6, y[-1])  # 現在値
        risk = float(min(1.0, yhat_next / (base*1.5)))  # ざっくり基準比
        return yhat_next, risk
    except Exception:
        return None

def bayes_update(items: List[Item]):
    """Beta-Bernoulli の超簡易版。トピック別に成功（risk的）/失敗をカウント"""
    out = []
    for topic, kws in TOPIC_MAP.items():
        alpha, beta = 1.0, 1.0  # 事前: Beta(1,1)
        for it in items:
            text = f"{it.title or ''} {it.summary or ''} {it.note or ''}".lower()
            is_risky = any(kw.lower() in text for kw in kws)
            if is_risky: alpha += 1.0
            else: beta += 1.0
        p = alpha / (alpha + beta)
        out.append({"topic": topic, "p_global_risk": round(float(p), 4)})
    return out

def build_cooccurrence_graph(items: List[Item]):
    """記事内エンティティの共起ネットワーク（簡易: 国名辞書のみ）"""
    G = nx.Graph()
    for it in items:
        text = f"{it.title or ''} {it.summary or ''} {it.note or ''}"
        ents = set()
        for r, kws in COUNTRY_KEYWORDS.items():
            if any(kw.lower() in text.lower() for kw in kws):
                ents.add(r)
        ents = list(ents)
        for n in ents:
            if not G.has_node(n):
                G.add_node(n, group="country")
        for i in range(len(ents)):
            for j in range(i+1, len(ents)):
                a, b = ents[i], ents[j]
                if G.has_edge(a, b):
                    G[a][b]["weight"] += 1
                else:
                    G.add_edge(a, b, weight=1)
    # 出力整形
    nodes = []
    for n, data in G.nodes(data=True):
        nodes.append({"id": n, "group": data.get("group","entity"), "degree": int(G.degree[n])})
    edges = []
    for u, v, data in G.edges(data=True):
        edges.append({"source": u, "target": v, "weight": int(data.get("weight",1))})
    # 上位だけに絞る（視覚ノイズ軽減）
    edges = sorted(edges, key=lambda e: e["weight"], reverse=True)[:50]
    keep = set([e["source"] for e in edges] + [e["target"] for e in edges])
    nodes = [n for n in nodes if n["id"] in keep]
    return {"nodes": nodes, "edges": edges}

def cluster_news(texts: List[str], k: int = 5):
    """言語非依存の char n-gram TF-IDF → KMeans"""
    if not texts:
        return []
    # 日本語もあるので文字n-gramで妥協（精度を上げるなら分かち書き導入）
    vec = TfidfVectorizer(analyzer="char", ngram_range=(2,3), min_df=2)
    X = vec.fit_transform(texts)
    k = max(2, min(k, X.shape[0]//5 or 2))
    km = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = km.fit_predict(X)

    # クラスタごとの代表キーワード
    clusters = []
    terms = np.array(vec.get_feature_names_out())
    # セントロイド上位 n-gram
    order_centroids = km.cluster_centers_.argsort()[:, ::-1]
    for i in range(k):
        idx = np.where(labels == i)[0]
        count = len(idx)
        # 代表語
        top_terms = [t for t in terms[order_centroids[i, :15]] if t.strip()]
        label = "".join(top_terms[:3])[:12] or f"Cluster-{i}"
        clusters.append({"label": label, "keywords": top_terms[:10], "count": count})
    return clusters

def _fig_to_png_bytes(fig) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()

# ---------- Main Endpoint ----------
@app.post("/api/forecast")
async def forecast(req: ForecastReq):
    items = req.items or []
    horizon = int(req.horizonDays)

    result: Dict[str, Any] = {
        "as_of_jst": now_jst_str(),
        "coverage_count": len(items),
        "top_themes": [],
        "signals": [],
        "scenarios_7_14d": [],
        "gaia_lens": {"climate_signals": [], "environmental_risks": [], "note": ""},
        "caveats": "Experimental analytics; dictionary-based NER and lightweight models.",
        "confidence_overall": 0.5,
    }

    # ===== intent: timeseries_forecast =====
    region_series = build_region_series(items, bin_min=60)
    regional_out = []
    steps = max(1, min(24 * horizon, 24*14))
    for region, (ts, y) in region_series.items():
        if len(y) == 0:
            continue
        arima_rate = arima_forecast(y, steps=steps)
        pois = poisson_risk(y)
        risk_score = None
        if pois is not None:
            yhat_next, risk = pois
            risk_score = float(risk)
            if arima_rate is None:
                arima_rate = float(yhat_next)
        if arima_rate is not None:
            regional_out.append({
                "region": region,
                "expected_rate": round(float(arima_rate), 3),
                "risk_score": round(float(risk_score), 3) if risk_score is not None else None
            })
    regional_out = sorted(regional_out, key=lambda r: (r["risk_score"] or 0), reverse=True)[:12]

    # ===== intent: bayesian_update =====
    topic_risk = bayes_update(items)

    # ===== intent: cooccurrence_network =====
    graph = build_cooccurrence_graph(items)

    # ===== intent: clustering =====
    texts = [f"{it.title or ''} {it.summary or ''} {it.note or ''}" for it in items]
    clusters = cluster_news(texts, k=6)

    # ===== signals / scenarios (demo) =====
    signals, scenarios = [], []
    if regional_out:
        top = regional_out[0]
        signals = [{
            "headline": f"{top['region']}: news rate spike risk",
            "why_it_matters": "Sudden uptick in headline velocity could signal developing events.",
            "region": top["region"],
            "confidence": min(0.9, (top["risk_score"] or 0.5) + 0.1),
            "window_days": min(14, horizon)
        }]
        scenarios = [{
            "name": f"{top['region']} volatility",
            "description": "News volume may fluctuate above baseline; monitor official statements and markets.",
            "probability": min(0.8, (top["risk_score"] or 0.4) + 0.2),
            "triggers": ["Official warnings", "Military movements", "Market selloff"],
            "watchlist": ["FX rate", "Energy prices", "Gov pressers"]
        }]

    # === intents を揃えて格納 ===
    result.update({
        "regional_forecast": regional_out,
        "topic_risk": topic_risk,
        "graph": graph,
        "clusters": clusters,
        "signals": signals,
        "scenarios_7_14d": scenarios,
        "top_themes": [c["label"] for c in clusters[:5]],
        "intents": [
            {"name": "timeseries_forecast", "output": regional_out},
            {"name": "bayesian_update", "output": topic_risk},
            {"name": "cooccurrence_network", "output": graph},
            {"name": "clustering", "output": clusters},
        ]
    })

    global _LAST_ITEMS
    _LAST_ITEMS = items[:]           # ← 直近アイテムを保持

    return result


# @app.get("/api/plot/regional_lines")
# def plot_regional_lines():
#     items = _LAST_ITEMS
#     if not items:
#         return StreamingResponse(io.BytesIO(b""), media_type="image/png")

#     region_series = build_region_series(items, bin_min=60)  # 1時間ビン
#     # 表示する地域を「総件数の多い順」に上位6
#     totals = []
#     for r, (_, y) in region_series.items():
#         totals.append((r, int(y.sum())))
#     top = [r for r, _ in sorted(totals, key=lambda x: x[1], reverse=True)[:6]]

#     fig, ax = plt.subplots(figsize=(9, 4))
#     for r in top:
#         ts, y = region_series[r]
#         if len(y) == 0: 
#             continue
#         # x軸はローカルJSTの時刻ラベル
#         x = [t.strftime("%m/%d %H:%M") for t in ts]
#         ax.plot(x, y, label=r, linewidth=1.8)

#     ax.set_title("Hourly News Count by Region (Top 6)")
#     ax.set_xlabel("JST time")
#     ax.set_ylabel("Articles / hour")
#     ax.tick_params(axis='x', labelrotation=45)
#     ax.grid(alpha=0.25)
#     ax.legend(loc="upper left", ncol=3, fontsize=8, frameon=False)
#     buf = io.BytesIO()
#     plt.plot([1,2,3], [4,5,6])   # 仮のデータ
#     plt.savefig(buf, format="png")
#     plt.close()
#     buf.seek(0)  # ★これ必須


#     # ↓ 追加
#     png = _fig_to_png_bytes(fig)
#     return StreamingResponse(buf, media_type="image/png")


@app.get("/api/plot/regional_lines")

def plot_regional_lines():
    items = _LAST_ITEMS
    print("items:", len(items))
    if not items:
        # 空でも小さな画像を返す（onErrorで消えないように）
        fig, ax = plt.subplots(figsize=(2, 1))
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
        plt.close(fig); buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")

    region_series = build_region_series(items, bin_min=60)  # 1時間ビン
    # 総件数の多い順で上位6
    totals = [(r, int(y.sum())) for r, (_, y) in region_series.items()]
    top = [r for r, _ in sorted(totals, key=lambda x: x[1], reverse=True)[:6]]

    fig, ax = plt.subplots(figsize=(9, 4))

    plotted = False
    for r in top:
        ts, y = region_series[r]
        if len(y) == 0:
            continue
        # 文字列ではなく datetime をそのまま渡す
        ax.plot(ts, y, label=r, linewidth=1.8)
        plotted = True

    if not plotted:
        # 描くものが無いときはプレースホルダー
        ax.text(0.5, 0.5, "No regional data", ha="center", va="center",
                transform=ax.transAxes)
    # x軸を日時フォーマットに
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d %H:%M"))
    fig.autofmt_xdate()

    ax.set_title("Hourly News Count by Region (Top 6)")
    ax.set_xlabel("JST time")
    ax.set_ylabel("Articles / hour")
    ax.grid(alpha=0.25)
    ax.legend(loc="upper left", ncol=3, fontsize=8, frameon=False)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
    plt.close(fig); buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.get("/api/plot/risk_bars")
def plot_risk_bars():
    items = _LAST_ITEMS
    print("items:", len(items))

    if not items:
        fig, ax = plt.subplots(figsize=(1, 1))
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
        plt.close(fig)
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")

    region_series = build_region_series(items, bin_min=60)
    rows = []
    for r, (_, y) in region_series.items():
        if len(y) == 0:
            continue
        pois = poisson_risk(y)
        risk = pois[1] if pois is not None else 0.0
        rows.append((r, float(risk)))
    rows.sort(key=lambda x: x[1], reverse=True)
    rows = rows[:10]

    if not rows:
        fig, ax = plt.subplots(figsize=(1, 1))
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
        plt.close(fig)
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")

    labels = [r for r, _ in rows]
    vals   = [v for _, v in rows]

    fig, ax = plt.subplots(figsize=(6, 4))
    y_pos = range(len(labels))
    ax.barh(list(y_pos), vals)
    ax.set_yticks(list(y_pos))
    ax.set_yticklabels(labels)
    ax.invert_yaxis()
    ax.set_xlim(0, 1)
    ax.set_xlabel("Risk score (0–1)")
    ax.set_title("Spike Risk by Region (Poisson baseline)")
    for i, v in enumerate(vals):
        ax.text(min(0.98, v + 0.02), i, f"{v:.2f}", va="center", fontsize=9)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
    plt.close(fig)
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")

# @app.get("/api/plot/cooccurrence")
# def plot_cooccurrence():
#     items = _LAST_ITEMS
#     if not items:
#         return StreamingResponse(io.BytesIO(b""), media_type="image/png")

#     g = build_cooccurrence_graph(items)
#     import networkx as nx
#     G = nx.Graph()
#     for n in g["nodes"]:
#         G.add_node(n["id"])
#     for e in g["edges"]:
#         G.add_edge(e["source"], e["target"], weight=e.get("weight", 1))

#     if G.number_of_nodes() == 0:
#         return StreamingResponse(io.BytesIO(b""), media_type="image/png")

#     pos = nx.spring_layout(G, seed=42, k=0.8)
#     weights = [G[u][v]["weight"] for u, v in G.edges()]
#     fig, ax = plt.subplots(figsize=(6.8, 5.2))
#     nx.draw_networkx_nodes(G, pos, node_size=550, node_color="#88ddff", alpha=0.9, ax=ax)
#     nx.draw_networkx_labels(G, pos, font_size=9, font_weight="bold", ax=ax)
#     nx.draw_networkx_edges(G, pos, width=[0.8 + w*0.4 for w in weights], alpha=0.6, ax=ax)
#     ax.set_axis_off()
#     ax.set_title("Country Co-occurrence Network")
#     buf = io.BytesIO()
#     plt.plot([1,2,3], [4,5,6])   # 仮のデータ
#     plt.savefig(buf, format="png")
#     plt.close()
#     buf.seek(0)  # ★これ必須

#     png = _fig_to_png_bytes(fig)
#     return StreamingResponse(buf, media_type="image/png")

@app.get("/api/plot/cooccurrence")
def plot_cooccurrence():
    items = _LAST_ITEMS
    print("items:", len(items))

    if not items:
        fig, ax = plt.subplots(figsize=(1, 1))
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
        plt.close(fig)
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")

    g = build_cooccurrence_graph(items)
    import networkx as nx
    G = nx.Graph()
    for n in g["nodes"]:
        G.add_node(n["id"])
    for e in g["edges"]:
        G.add_edge(e["source"], e["target"], weight=e.get("weight", 1))

    if G.number_of_nodes() == 0:
        fig, ax = plt.subplots(figsize=(1, 1))
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
        plt.close(fig)
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")

    pos = nx.spring_layout(G, seed=42, k=0.8)
    weights = [G[u][v]["weight"] for u, v in G.edges()]
    fig, ax = plt.subplots(figsize=(6.8, 5.2))
    nx.draw_networkx_nodes(G, pos, node_size=550, node_color="#88ddff", alpha=0.9, ax=ax)
    nx.draw_networkx_labels(G, pos, font_size=9, font_weight="bold", ax=ax)
    nx.draw_networkx_edges(G, pos, width=[0.8 + w*0.4 for w in weights], alpha=0.6, ax=ax)
    ax.set_axis_off()
    ax.set_title("Country Co-occurrence Network")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=160)
    plt.close(fig)
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")




@app.get("/api/rss")
def proxy_rss(url: str):
    """RSSフィードをサーバ経由で取得（CORS回避）"""
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        resp = requests.get(url, headers=headers, timeout=10)
        resp.raise_for_status()
        return PlainTextResponse(resp.text, media_type="application/xml")
    except Exception as e:
        return PlainTextResponse(f"Error: {e}", status_code=502)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)