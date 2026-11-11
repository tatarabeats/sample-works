"""公開されている「お知らせ」一覧を集めて CSV にする小さなツール（自主制作の見本）。

対象: デジタル庁ウェブサイトの「お知らせ」一覧 https://www.digital.go.jp/news
  - 利用規約: 公共データ利用規約（第1.0版・PDL1.0）。出典を書けば複製・加工・商用利用ができる
    https://www.digital.go.jp/copyright-policy
  - robots.txt: /news は Disallow に無い。Crawl-delay: 1 → このツールは1回ごとに2秒あける
使い方:
    python collect_news.py            → news.csv（20件）と fetch-log.json を作る
    python collect_news.py --limit 40 → 40件まで
必要な物: Python 3.9 以上だけ（標準ライブラリのみ。追加のインストールは要らない）
"""
import argparse
import csv
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.request
import urllib.robotparser
from pathlib import Path

BASE = "https://www.digital.go.jp"
LIST = BASE + "/news"
UA = "sample-news-collector/1.0 (portfolio sample; 2s interval)"
WAIT = 2.0
HERE = Path(__file__).resolve().parent

CARD = re.compile(
    r'<a\s+class="card"\s+href="(?P<href>[^"]+)"[^>]*>.*?'
    r'<p class="card__title">\s*<span>(?P<title>.*?)</span>.*?'
    r'(?:<span class="card__news-category">\s*(?P<cat>.*?)\s*</span>.*?)?'
    r'<time class="card__news-date" datetime="(?P<date>[\d-]+)"',
    re.S)


def fetch(url, log):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode("utf-8", "replace")
        log.append({"url": url, "status": r.status, "bytes": len(body), "at": dt.datetime.now().isoformat(timespec="seconds")})
        return body


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--out", default=str(HERE / "news.csv"))
    a = ap.parse_args()

    rp = urllib.robotparser.RobotFileParser(BASE + "/robots.txt")
    rp.read()
    if not rp.can_fetch(UA, LIST):
        sys.exit("robots.txt で許可されていないため中止します")

    log, rows, seen, page = [], [], set(), 0
    while len(rows) < a.limit and page < 10:
        url = LIST if page == 0 else f"{LIST}?page={page}"
        if not rp.can_fetch(UA, url):
            break
        found = 0
        for m in CARD.finditer(fetch(url, log)):
            link = m.group("href")
            link = link if link.startswith("http") else BASE + link
            key = (m.group("date"), clean(m.group("title")), link)  # 同じ URL でも別のお知らせは残す
            if key in seen:
                continue
            seen.add(key)
            found += 1
            rows.append({"掲載日": m.group("date"), "区分": clean(m.group("cat")) or "（区分なし）",
                         "件名": clean(m.group("title")), "URL": link})
            if len(rows) >= a.limit:
                break
        if not found:
            break
        page += 1
        time.sleep(WAIT)

    got = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(a.out, "w", encoding="utf-8-sig", newline="") as f:  # Excel でそのまま開けるよう BOM 付き
        w = csv.DictWriter(f, fieldnames=["No", "掲載日", "区分", "件名", "URL", "取得日時"])
        w.writeheader()
        for i, r in enumerate(rows, 1):
            w.writerow({"No": i, **r, "取得日時": got})
    (HERE / "fetch-log.json").write_text(json.dumps({"requests": log, "rows": len(rows), "robots_allowed": True,
                                                     "user_agent": UA, "interval_seconds": WAIT}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(rows)}件を {a.out} に書きました（リクエスト {len(log)} 回・間隔 {WAIT} 秒）")


if __name__ == "__main__":
    main()
