# ac-problems-contest-bot

## 前提

- `git`
- `mise`

## セットアップ

```bash
git clone git@github.com:tossyhal/ac-problems-contest-bot.git
cd ac-problems-contest-bot
```

ローカルの `mise` 設定を trust し、指定されたツールをインストールします。

```bash
mise trust
mise install
```

依存関係をインストールします。

```bash
pnpm install --frozen-lockfile
```

`.dev.vars` は [`.dev.vars.example`](/home/hal/develop/ac-problems-contest-bot/.dev.vars.example) を元に作成します。

```bash
cp .dev.vars.example .dev.vars
```

## 開発

ローカル開発サーバーを起動します。

```bash
pnpm dev
```

起動後は以下で API 関連の確認ができます。

- OpenAPI JSON: `http://localhost:8787/doc`
- Scalar API Reference: `http://localhost:8787/reference`
- Health check: `http://localhost:8787/health`
- Discord endpoint: `POST http://localhost:8787/discord/interactions`

## Cloudflare セットアップ

まず Cloudflare にログインします。

```bash
pnpm exec wrangler login
```

D1 を未作成なら作成し、表示された `database_id` を `wrangler.jsonc` に反映します。

```bash
pnpm exec wrangler d1 create ac-problems-contest-bot
```

Worker に必要な secret は Cloudflare 側へ登録します。

```bash
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put ATCODER_PROBLEMS_TOKEN
```

`DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN`、`DISCORD_GUILD_ID` は command 登録用なので、通常は `.dev.vars` だけで十分です。

## D1 / Drizzle

ローカル D1 へ migration を適用します。

```bash
pnpm db:migrate:local
```

スキーマ変更から migration ファイルを生成する場合は以下を使います。

```bash
pnpm db:generate
```

`wrangler.jsonc` の `database_id` はプレースホルダです。実運用用の D1 を作成したら実 ID に置き換えてください。

schema を変更したときだけ remote D1 に migration を適用します。

```bash
pnpm exec wrangler d1 migrations apply DB --remote
```

## Discord

Discord interaction の署名検証には `DISCORD_PUBLIC_KEY` secret が必要です。
`/start` と `/custom-start` で AtCoder Problems のバチャを実際に作成するには、
`ATCODER_PROBLEMS_TOKEN` も必要です。

開発用 guild に slash command を登録するには、`.dev.vars` に次を設定します。

- `DISCORD_APPLICATION_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`

そのうえで以下を実行します。

```bash
pnpm discord:register:guild
```

Discord Developer Portal の `Interactions Endpoint URL` は、deploy 後の Worker URL に対して次を設定します。

```text
https://<your-workers-url>/discord/interactions
```

## デプロイ

```bash
pnpm exec wrangler deploy
```

Durable Object の class 追加は `wrangler.jsonc` の `migrations` で管理しているため、最新 deploy で反映されます。

## 初回利用フロー

1. `/setting action:update` で `atcoder-user-id` を設定する
2. 必要なら `problem-count`、`contest-minutes`、`difficulty-bands` なども設定する
3. `/init action:run` で初回提出同期を実行する
4. `/init action:status` で `completed` を確認する
5. `/start` または `/custom-start` を実行する

`/start` と `/custom-start` は実行前に提出情報の増分同期を 1 バッチ分だけ行います。続きを要する場合は同期ジョブを再開し、「少し待ってから再実行してください」を返します。

## チェック

```bash
pnpm check
pnpm typecheck
pnpm test
```

## Git Hooks

`pnpm install` 実行時に Husky が自動で有効化されます。

- `pre-commit`: `lint-staged` を実行
- `commit-msg`: `commitlint` でコミットメッセージを検証

## コミットメッセージ規約

Conventional Commits を使用します。

例:

- `docs: add setup guide`
- `feat: add health route`
- `fix(worker): handle invalid payload`

## 注意

- このリポジトリでは `pnpm` の `minimumReleaseAge` を設定しています。
- 公開から 7 日未満の npm package はインストールできません。
- そのため、依存更新時に最新版をすぐ取り込めないことがあります。
