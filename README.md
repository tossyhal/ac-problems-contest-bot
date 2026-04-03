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
