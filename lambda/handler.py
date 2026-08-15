"""AIP-C01問題集アプリ用の薄いプロキシLambda。

ブラウザ(静的フロントエンド)はSigV4署名ができないため、このLambdaが
bedrock-agentcore:InvokeAgentRuntime を代行して Strands Agent (AgentCore Runtime)
を呼び出し、結果をそのままJSONで返す。
"""
import json
import os
import uuid

import boto3

RUNTIME_ARN = os.environ["AGENTCORE_RUNTIME_ARN"]
REGION = os.environ.get("AWS_REGION", "us-east-1")

client = boto3.client("bedrock-agentcore", region_name=REGION)

CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _response(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}) or {}).get("method", "POST")
    if method == "OPTIONS":
        return _response(200, {})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    action = body.get("action")
    if action not in ("pick", "analyze"):
        return _response(400, {"error": "action must be 'pick' or 'analyze'"})

    session_id = body.get("sessionId") or str(uuid.uuid4())
    # AgentCore Runtime のセッションIDは33文字以上必須
    if len(session_id) < 33:
        session_id = (session_id + "-" + uuid.uuid4().hex)[:64]

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")

    try:
        resp = client.invoke_agent_runtime(
            agentRuntimeArn=RUNTIME_ARN,
            runtimeSessionId=session_id,
            contentType="application/json",
            accept="application/json",
            payload=payload,
        )
        raw = resp["response"].read()
        result = json.loads(raw)
        return _response(200, result)
    except Exception as e:  # noqa: BLE001
        return _response(502, {"error": str(e)})
