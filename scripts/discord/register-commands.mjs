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
  },
  {
    name: "setting",
    description: "デフォルト設定の表示と更新を行う",
    type: 1,
  },
  {
    name: "init",
    description: "初期同期の実行と同期状態の確認を行う",
    type: 1,
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
const token = requireEnv("DISCORD_TOKEN");

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
