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

## Discord

Discord interaction の署名検証には `DISCORD_PUBLIC_KEY` secret が必要です。
`/start` と `/custom-start` で AtCoder Problems のバチャを実際に作成するには、
`ATCODER_PROBLEMS_TOKEN` も必要です。

開発用 guild に slash command を登録するには、`.dev.vars` に
`DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN`、`DISCORD_GUILD_ID` を設定したうえで以下を実行します。

```bash
pnpm discord:register:guild
```

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
