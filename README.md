# AWS Certified Generative AI Developer - Professional 問題集

AWS Certified Generative AI Developer - Professional (AIP-C01) の学習用Web問題集。
[公式試験ガイド](https://docs.aws.amazon.com/aws-certification/latest/ai-professional-01/)のドメイン配点・タスクステートメントに基づいてオリジナル問題を作成。

## 機能

- **問題バンク1000問**(D1:310 / D2:260 / D3:200 / D4:120 / D5:110、公式配点比率31/26/20/12/11%に一致)
- 出題形式は5パターン(5択最も適切/6択から3つ/5〜6択から2つ/5択誤り1つ/5〜6択誤り2つ)を混在
- **ランダム200問**・**カテゴリー別100問**(1問ごとに解説表示)
- **模擬試験85問**(180分カウントダウンタイマー付き、採点はまとめて表示)
- **一問一答フラッシュカード**(ランダム150問)
- 🤖 **AIコーチ**: Strands Agent(Amazon Bedrock AgentCore Runtime)による、誤答傾向に基づく「苦手問題を復習」モードと「弱点分析」

## 構成

- `index.html` / `styles.css` / `app.js` / `questions.js` — フロントエンド(静的、Vercelでホスティング)
- `agent/` — 学習コーチ用Strands Agent(Amazon Bedrock AgentCore Runtimeにデプロイ)
- `lambda/` — ブラウザ→AgentCore Runtime間のプロキシLambda(API Gateway経由)

## ローカル実行

```bash
python3 -m http.server 8642
```

`http://localhost:8642` を開く。
