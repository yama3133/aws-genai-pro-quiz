"""AIP-C01問題集アプリ用の薄いプロキシLambda。

ブラウザ(静的フロントエンド)はSigV4署名ができないため、このLambdaが
2つの役割を代行する:

  - action=pick / analyze : bedrock-agentcore:InvokeAgentRuntime で
    Strands Agent (AgentCore Runtime) を呼び出す。
  - action=translate      : 問題文の多言語表示用に、Amazon Bedrock を
    直接 Converse で呼び出して翻訳する(AgentCore Runtimeは経由しない。
    単純なテキスト変換にエージェントのツール呼び出しは不要なため)。
"""
import json
import os
import uuid

import boto3

RUNTIME_ARN = os.environ["AGENTCORE_RUNTIME_ARN"]
REGION = os.environ.get("AWS_REGION", "us-east-1")
TRANSLATE_MODEL_ID = os.environ.get(
    "TRANSLATE_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0"
)

agentcore_client = boto3.client("bedrock-agentcore", region_name=REGION)
bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)

CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

LANG_NAMES = {
    "en": "English",
    "zh": "Simplified Chinese",
    "ko": "Korean",
    "es": "Spanish",
    "ar": "Arabic",
}


def _response(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _handle_agent(body: dict) -> dict:
    session_id = body.get("sessionId") or str(uuid.uuid4())
    # AgentCore Runtime のセッションIDは33文字以上必須
    if len(session_id) < 33:
        session_id = (session_id + "-" + uuid.uuid4().hex)[:64]

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")

    resp = agentcore_client.invoke_agent_runtime(
        agentRuntimeArn=RUNTIME_ARN,
        runtimeSessionId=session_id,
        contentType="application/json",
        accept="application/json",
        payload=payload,
    )
    raw = resp["response"].read()
    return json.loads(raw)


def _handle_translate(body: dict) -> dict:
    texts = body.get("texts")
    target_lang = body.get("targetLang")
    if not isinstance(texts, list) or not texts:
        raise ValueError("texts must be a non-empty array")
    lang_name = LANG_NAMES.get(target_lang)
    if not lang_name:
        raise ValueError(f"unsupported targetLang: {target_lang!r}")

    numbered = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(texts))
    prompt = (
        f"Translate each numbered line below from Japanese to {lang_name}. "
        f"This is exam question content (question text, answer options, or an "
        f"explanation) for an AWS certification quiz app — keep AWS service "
        f"names, technical terms, and option labels (A/B/C/D...) accurate and "
        f"unchanged where they are proper nouns. "
        f"Return ONLY a JSON array of {len(texts)} translated strings, in the "
        f"same order, with no extra commentary, no markdown code fences.\n\n"
        f"{numbered}"
    )

    resp = bedrock_client.converse(
        modelId=TRANSLATE_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 4096, "temperature": 0},
    )
    raw_text = resp["output"]["message"]["content"][0]["text"].strip()
    start = raw_text.index("[")
    end = raw_text.rindex("]") + 1
    translations = json.loads(raw_text[start:end])
    if not isinstance(translations, list) or len(translations) != len(texts):
        raise ValueError("translation output length mismatch")
    return {"translations": translations}


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}) or {}).get("method", "POST")
    if method == "OPTIONS":
        return _response(200, {})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    action = body.get("action")
    if action not in ("pick", "analyze", "translate"):
        return _response(400, {"error": "action must be 'pick', 'analyze', or 'translate'"})

    try:
        if action == "translate":
            return _response(200, _handle_translate(body))
        return _response(200, _handle_agent(body))
    except Exception as e:  # noqa: BLE001
        return _response(502, {"error": str(e)})
