export type CommandLogInput = {
  commandContext?: string;
  commandName: string;
  message?: string;
  settingsSummary?: string;
  status: string;
};

export const insertCommandLog = async (
  database: D1Database,
  input: CommandLogInput,
) => {
  await database
    .prepare(
      `INSERT INTO command_logs (
        command_name,
        command_context,
        status,
        settings_summary,
        message
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.commandName,
      input.commandContext ?? null,
      input.status,
      input.settingsSummary ?? null,
      input.message ?? null,
    )
    .run();
};
