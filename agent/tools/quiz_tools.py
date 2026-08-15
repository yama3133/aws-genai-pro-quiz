"""AIP-C01 問題集アプリ用のツール群。

- pick_questions: 出題プールから次に解く問題IDを選ぶ(ランダム or 弱点優先の重み付け)。
- analyze_mistakes: 回答履歴を集計し、ドメイン別正答率・誤答傾向の統計を返す。
  文章化(学習アドバイスの生成)はエージェント本体(FM)が行う。
"""
from __future__ import annotations

import json
import random
from collections import defaultdict

from strands.tools import tool


@tool
def pick_questions(pool_json: str, history_json: str, mode: str, count: int) -> str:
    """出題プールから次に解くべき問題IDを選ぶ。

    Args:
        pool_json: 出題候補のJSON配列文字列。各要素は {"id": str, "domain": int}。
        history_json: これまでの回答履歴のJSON配列文字列。各要素は
            {"id": str, "domain": int, "correct": bool}。履歴がなければ "[]"。
        mode: "random"(完全ランダム) または "weak_focus"(誤答・未回答の問題を優先)。
        count: 選択する問題数の上限。

    Returns:
        選択された問題IDのJSON配列文字列(出題順)。
    """
    pool = json.loads(pool_json) if pool_json else []
    history = json.loads(history_json) if history_json else []

    if not pool:
        return json.dumps([])

    if mode != "weak_focus" or not history:
        ids = [q["id"] for q in pool]
        random.shuffle(ids)
        return json.dumps(ids[: int(count)])

    # weak_focus: 誤答実績のある問題・未回答の問題ほど重みを高くする
    stats: dict[str, dict[str, int]] = defaultdict(lambda: {"correct": 0, "wrong": 0})
    for h in history:
        key = h.get("id")
        if key is None:
            continue
        if h.get("correct"):
            stats[key]["correct"] += 1
        else:
            stats[key]["wrong"] += 1

    def weight(qid: str) -> float:
        s = stats.get(qid)
        if s is None:
            return 3.0  # 未回答は優先度をやや高めにする
        total = s["correct"] + s["wrong"]
        if total == 0:
            return 3.0
        accuracy = s["correct"] / total
        # 正答率が低い(誤答が多い)ほど重みを高くする
        return 1.0 + (1.0 - accuracy) * 4.0

    ids = [q["id"] for q in pool]
    weights = [weight(qid) for qid in ids]

    selected: list[str] = []
    remaining_ids = ids[:]
    remaining_weights = weights[:]
    n = min(int(count), len(remaining_ids))
    for _ in range(n):
        chosen = random.choices(remaining_ids, weights=remaining_weights, k=1)[0]
        idx = remaining_ids.index(chosen)
        selected.append(remaining_ids.pop(idx))
        remaining_weights.pop(idx)

    return json.dumps(selected)


@tool
def analyze_mistakes(history_json: str) -> str:
    """回答履歴を集計し、ドメイン別正答率と誤答が多い問題の統計を返す。

    Args:
        history_json: 回答履歴のJSON配列文字列。各要素は
            {"id": str, "domain": int, "domain_name": str, "correct": bool,
             "question": str(任意), "explanation": str(任意)}。

    Returns:
        ドメイン別正答率、誤答サンプル(最大15件)を含むJSON文字列の統計データ。
        このツールは数値集計のみを行い、学習アドバイスの文章化はエージェント自身が行う。
    """
    history = json.loads(history_json) if history_json else []
    if not history:
        return json.dumps({"total": 0, "domains": {}, "wrong_samples": []})

    domain_counts: dict[str, dict[str, int]] = defaultdict(lambda: {"correct": 0, "wrong": 0})
    domain_names: dict[str, str] = {}
    wrong_samples = []

    for h in history:
        dkey = str(h.get("domain", "?"))
        if h.get("domain_name"):
            domain_names[dkey] = h["domain_name"]
        if h.get("correct"):
            domain_counts[dkey]["correct"] += 1
        else:
            domain_counts[dkey]["wrong"] += 1
            if h.get("question"):
                wrong_samples.append(
                    {
                        "id": h.get("id"),
                        "domain": dkey,
                        "question": str(h.get("question", ""))[:200],
                        "explanation": str(h.get("explanation", ""))[:300],
                    }
                )

    domains = {}
    for dkey, counts in domain_counts.items():
        total = counts["correct"] + counts["wrong"]
        domains[dkey] = {
            "name": domain_names.get(dkey, ""),
            "correct": counts["correct"],
            "wrong": counts["wrong"],
            "accuracy": round(counts["correct"] / total, 3) if total else None,
        }

    result = {
        "total": len(history),
        "domains": domains,
        "wrong_samples": wrong_samples[:15],
    }
    return json.dumps(result, ensure_ascii=False)
