#!/usr/bin/env python3
"""Refresh the salary data embedded in index.html from the BLS OEWS public API.

Optional and dev-time only. The site never runs this. It rewrites the
<script data-src="js/data/salaries.js"> block inside index.html in place.

    python3 scripts/build_salaries.py            # fetch (cached) + write
    BLS_API_KEY=... python3 scripts/build_salaries.py   # faster, higher limits

Without a key, the BLS v1 API allows ~25 requests/day of 25 series each.
Every series response is cached in scripts/.cache/, so a run that hits the
daily limit can simply be re-run tomorrow and it picks up where it left off.

Missing data policy ("estimate on the lower end"):
  1. Industry-specific value missing  -> national 25th percentile for that SOC.
  2. National value missing too       -> the config's "fallback" annual figure,
                                         or a conservative $40,000 floor.
  Top-coded BLS values (shown as '#', >= $239,200) are clamped to the cap.
Anything not taken straight from BLS is flagged with `est: true`.
"""
from __future__ import annotations

import json
import re
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "scripts" / "roles.config.json"
CACHE = ROOT / "scripts" / ".cache"
OUT = ROOT / "index.html"
BLOCK = re.compile(r'(<script data-src="js/data/salaries\.js">\n).*?(\n</script>)', re.S)

TOP_CODE = 239_200          # BLS publishes '#' above this annual wage
FLOOR = 40_000              # last-resort conservative estimate
DATATYPES = {"mean": "04", "p25": "12", "p75": "14"}

API_KEY = os.environ.get("BLS_API_KEY", "").strip()
API_URL = ("https://api.bls.gov/publicAPI/v2/timeseries/data/" if API_KEY
           else "https://api.bls.gov/publicAPI/v1/timeseries/data/")
BATCH = 50 if API_KEY else 25
USER_AGENT = "meeting-meter-salary-script"


def series_id(industry: str, soc: str, datatype: str) -> str:
    # OEU + N(national) + area(7) + industry(6) + occupation(6) + datatype(2)
    return f"OEUN0000000{industry}{soc}{datatype}"


def parse_value(raw: str | None) -> tuple[int | None, bool]:
    """Return (annual wage, was_top_coded)."""
    if raw is None:
        return None, False
    raw = raw.strip()
    if raw in ("#", ">=239,200") or raw.startswith(">"):
        return TOP_CODE, True
    try:
        return int(float(raw.replace(",", ""))), False
    except ValueError:
        return None, False          # '-', '*', '**' = not available


def load_cache() -> dict[str, str | None]:
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / "series.json"
    return json.loads(f.read_text()) if f.exists() else {}


def save_cache(cache: dict) -> None:
    (CACHE / "series.json").write_text(json.dumps(cache, indent=0, sort_keys=True))


def fetch(ids: list[str], cache: dict) -> None:
    todo = [i for i in ids if i not in cache]
    print(f"{len(ids)} series needed, {len(todo)} not cached "
          f"(~{-(-len(todo) // BATCH)} requests)")
    for start in range(0, len(todo), BATCH):
        chunk = todo[start:start + BATCH]
        body = {"seriesid": chunk}
        if API_KEY:
            body["registrationkey"] = API_KEY
        req = urllib.request.Request(
            API_URL, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=90) as resp:
            payload = json.load(resp)
        if payload.get("status") != "REQUEST_SUCCEEDED":
            msg = " ".join(payload.get("message", []))
            save_cache(cache)
            sys.exit(f"BLS API stopped us: {msg}\nCache saved; re-run later "
                     "(or set BLS_API_KEY) to continue.")
        for s in payload["Results"]["series"]:
            data = s.get("data") or []
            cache[s["seriesID"]] = data[0]["value"] if data else None
            if data:
                cache["_year"] = max(cache.get("_year") or "", data[0]["year"])
        save_cache(cache)
        print(f"  fetched {start + len(chunk)}/{len(todo)}")
        time.sleep(1)


def main() -> None:
    cfg = json.loads(CONFIG.read_text())
    general = cfg["general"]
    groups = [general] + cfg["industries"]

    ids = [series_id(g["industry"], r["soc"], dt)
           for g in groups for r in g["roles"] for dt in DATATYPES.values()]
    # National p25 for every SOC used anywhere (needed for the fallback).
    socs = {r["soc"] for g in groups for r in g["roles"]}
    ids += [series_id(general["industry"], soc, DATATYPES["p25"]) for soc in socs]
    ids = list(dict.fromkeys(ids))

    cache = load_cache()
    if "--offline" not in sys.argv:
        fetch(ids, cache)

    def lookup(industry: str, soc: str, key: str):
        return parse_value(cache.get(series_id(industry, soc, DATATYPES[key])))

    def build_role(industry: str, role: dict) -> dict:
        mean, top = lookup(industry, role["soc"], "mean")
        p25, _ = lookup(industry, role["soc"], "p25")
        p75, top75 = lookup(industry, role["soc"], "p75")
        est = False
        if mean is None:
            est = True
            nat_p25, _ = lookup(general["industry"], role["soc"], "p25")
            mean = nat_p25 or role.get("fallback") or FLOOR
        out = {"id": role["id"], "label": role["label"], "emoji": role.get("emoji", "🙂"),
               "soc": f'{role["soc"][:2]}-{role["soc"][2:]}', "mean": mean}
        if p25 is not None and p75 is not None and not est:
            out["range"] = [p25, p75]
        if top or top75:
            out["capped"] = True
        if est:
            out["est"] = True
        return out

    result = {
        "source": "U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics (OEWS), national",
        "period": f"May {cache.get('_year') or 'latest'}",
        "generated": time.strftime("%Y-%m-%d"),
        "hoursPerYear": 2080,
        "general": {"id": "all", "label": general["label"], "emoji": "🇺🇸",
                    "roles": [build_role(general["industry"], r) for r in general["roles"]]},
        "industries": [
            {"id": g["id"], "label": g["label"], "emoji": g.get("emoji", "🏢"),
             "naics": g["industry"].rstrip("0") or "0",
             "roles": [build_role(g["industry"], r) for r in g["roles"]]}
            for g in cfg["industries"]
        ],
    }

    estimated = sum(1 for g in [result["general"]] + result["industries"]
                    for r in g["roles"] if r.get("est"))
    code = ("// GENERATED by scripts/build_salaries.py. Do not edit by hand.\n"
            "// Annual wages in USD. `est` = BLS had no figure; low-end estimate used.\n"
            f"(globalThis.MM = globalThis.MM || {{}}).salaries = {json.dumps(result, indent=1, ensure_ascii=False)};")
    html = OUT.read_text()
    if not BLOCK.search(html):
        sys.exit("Couldn't find the salaries <script> block in index.html")
    OUT.write_text(BLOCK.sub(lambda m: m.group(1) + code + m.group(2), html, count=1))
    print(f"Updated salaries in {OUT.relative_to(ROOT)} ({estimated} estimated roles)")


if __name__ == "__main__":
    main()
