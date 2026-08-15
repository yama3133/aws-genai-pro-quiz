"""AIP-C01 問題集アプリの学習コーチ Strands Agent。

役割は2つ:
  1. pick  : 出題プールと回答履歴から、次に解く問題IDを選ぶ
             (ランダム、または誤答・未回答を優先する重み付け選択)。
  2. analyze: 回答履歴を分析し、弱点分野と復習の優先順位を日本語で助言する。

実際の選択ロジック・集計はすべて tools/quiz_tools.py 内の決定的なPython関数が行い、
エージェント(FM)はツールを呼び出して結果を整形・言語化する役割に徹する。

CLIで単発実行:
  $ python agent.py run-pick '{"pool":[...],"history":[...],"mode":"weak_focus","count":20}'
  $ python agent.py run-analyze '{"history":[...]}'

AgentCore Runtime用:
  $ python agent.py serve
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv
from strands import Agent

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

load_dotenv(HERE / ".env")

from tools.quiz_tools import analyze_mistakes, pick_questions  # noqa: E402

LOG = logging.getLogger("aip-quiz-coach")
logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

SYSTEM_PROMPT = """\
あなたはAWS Certified Generative AI Developer - Professional (AIP-C01) 受験者を
支援する学習コーチAgentです。以下の2つのツールを持っています。

- pick_questions: 出題プールと回答履歴から、次に解く問題IDを選ぶ
- analyze_mistakes: 回答履歴を集計し、ドメイン別正答率と誤答傾向の統計を返す

依頼されたタスクの指示に厳密に従い、余計な処理は行わないこと。
「JSON配列のみを出力」と指示された場合は、説明文を一切付けずツールの出力をそのまま返す。
「学習アドバイスを書く」よう指示された場合は、統計の数値を並べるだけでなく、
受験対策として何を優先すべきかを日本語で簡潔にまとめる。
"""

PICK_PROMPT = """次の情報をもとに pick_questions ツールを呼び出してください。

pool_json:
{pool_json}

history_json:
{history_json}

mode: {mode}
count: {count}

ツールを上記の引数(pool_json, history_json, mode, count)で呼び出し、
ツールが返したJSON配列を一切加工せずそのまま出力してください。
説明文・前置き・コードブロックのマークダウンは不要です。JSON配列のみを出力してください。
"""

ANALYZE_PROMPT = """あなたはAIP-C01受験者の学習コーチです。次の回答履歴を分析してください。

history_json:
{history_json}

まず analyze_mistakes ツールを呼び出して統計を取得してください。
その結果をもとに、以下の3点を日本語・200〜300字程度でまとめてください。
- 正答率が低いドメイン(弱点分野)はどこか
- 誤答が目立つ問題からうかがえる理解不足の傾向
- 次に何を重点的に復習すべきか(具体的に)
数値の羅列ではなく、受験生への助言として自然な文章で書いてください。
回答履歴が空の場合は、まだ演習実績がない旨を伝えてください。
"""


def build_agent() -> Agent:
    from strands.models import BedrockModel

    import os

    region = os.environ.get("AWS_REGION", "us-east-1")
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-6",
        region_name=region,
    )
    return Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[pick_questions, analyze_mistakes],
    )


def run_pick(payload: dict) -> dict:
    pool_json = json.dumps(payload.get("pool", []), ensure_ascii=False)
    history_json = json.dumps(payload.get("history", []), ensure_ascii=False)
    mode = payload.get("mode", "random")
    count = int(payload.get("count", 20))

    agent = build_agent()
    prompt = PICK_PROMPT.format(
        pool_json=pool_json, history_json=history_json, mode=mode, count=count
    )
    result = agent(prompt)
    text = str(result).strip()
    try:
        start = text.index("[")
        end = text.rindex("]") + 1
        ids = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        LOG.warning("pick: failed to parse agent output as JSON array: %s", text[:200])
        ids = []
    return {"selected_ids": ids}


def run_analyze(payload: dict) -> dict:
    history_json = json.dumps(payload.get("history", []), ensure_ascii=False)
    agent = build_agent()
    prompt = ANALYZE_PROMPT.format(history_json=history_json)
    result = agent(prompt)
    return {"analysis": str(result).strip()}


# ----------------------------------------------------------------------
# AgentCore Runtime entrypoint
# ----------------------------------------------------------------------
try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp

    app = BedrockAgentCoreApp()

    @app.entrypoint
    def invoke(payload: dict) -> dict:
        action = (payload or {}).get("action", "")
        if action == "pick":
            return run_pick(payload)
        if action == "analyze":
            return run_analyze(payload)
        return {"error": f"unknown action: {action!r} (expected 'pick' or 'analyze')"}
except Exception:
    # ローカルCLI実行時はruntime SDKが無くてもOK
    app = None


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def cli() -> None:
    args = sys.argv[1:]
    if args and args[0] == "run-pick":
        payload = json.loads(args[1]) if len(args) > 1 else {}
        print(json.dumps(run_pick(payload), indent=2, ensure_ascii=False))
        return
    if args and args[0] == "run-analyze":
        payload = json.loads(args[1]) if len(args) > 1 else {}
        print(json.dumps(run_analyze(payload), indent=2, ensure_ascii=False))
        return
    print('usage: python agent.py run-pick \'{"pool":[...],"history":[...],"mode":"weak_focus","count":20}\'')
    print('       python agent.py run-analyze \'{"history":[...]}\'')
    print("       python agent.py serve")


if __name__ == "__main__":
    # direct_code_deploy は "python agent.py" を引数なしで起動するため、
    # 引数なし/"serve" のときはサーバー起動をデフォルトとする。
    # ローカルでのCLI検証時のみ run-pick / run-analyze を明示指定する。
    if len(sys.argv) > 1 and sys.argv[1] in ("run-pick", "run-analyze"):
        cli()
    else:
        if app is None:
            print("BedrockAgentCoreApp が import 出来ない。bedrock-agentcore パッケージを確認")
            sys.exit(1)
        app.run()
