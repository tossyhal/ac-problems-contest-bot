const commandDefinitions = [
  {
    name: "start",
    description: "保存済みデフォルト設定でバチャを作成する",
    type: 1,
  },
  {
    name: "custom-start",
    description: "今回だけ条件を上書きしてバチャを作成する",
    type: 1,
    options: [
      {
        type: 4,
        name: "problem-count",
        description: "問題数を上書きする",
        min_value: 1,
        max_value: 20,
      },
      {
        type: 4,
        name: "contest-duration-minutes",
        description: "コンテスト時間を分単位で上書きする",
        min_value: 10,
        max_value: 600,
      },
      {
        type: 4,
        name: "slot-minutes",
        description: "開始時刻の区切り分数を上書きする",
        choices: [
          { name: "5分", value: 5 },
          { name: "10分", value: 10 },
          { name: "15分", value: 15 },
          { name: "30分", value: 30 },
        ],
      },
      {
        type: 5,
        name: "unsolved-only",
        description: "未AC問題のみを対象にするかを上書きする",
      },
      {
        type: 5,
        name: "include-experimental-difficulty",
        description: "experimental difficulty を含めるかを上書きする",
      },
    ],
  },
  {
    name: "setting",
    description: "デフォルト設定の表示と更新を行う",
    type: 1,
    options: [
      {
        type: 3,
        name: "action",
        description: "実行する操作",
        required: true,
        choices: [
          { name: "show", value: "show" },
          { name: "update", value: "update" },
        ],
      },
    ],
  },
  {
    name: "init",
    description: "初期同期の実行と同期状態の確認を行う",
    type: 1,
    options: [
      {
        type: 3,
        name: "action",
        description: "実行する操作",
        required: true,
        choices: [
          { name: "run", value: "run" },
          { name: "status", value: "status" },
        ],
      },
    ],
  },
];

const requireEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const scope = process.argv[2] ?? "guild";

if (scope !== "guild" && scope !== "global") {
  console.error("Usage: node register-commands.mjs [guild|global]");
  process.exit(1);
}

const applicationId = requireEnv("DISCORD_APPLICATION_ID");
const token = requireEnv("DISCORD_BOT_TOKEN");

const endpoint =
  scope === "guild"
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${requireEnv("DISCORD_GUILD_ID")}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const response = await fetch(endpoint, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commandDefinitions),
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

const commands = await response.json();
const commandNames = commands.map((command) => command.name).join(", ");

console.log(`Registered ${scope} commands: ${commandNames}`);
