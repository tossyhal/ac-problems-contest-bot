export type DiscordCommandOption = {
  name: string;
  type: number;
  value?: boolean | number | string;
};

export type DiscordCommandData = {
  name: string;
  options?: DiscordCommandOption[];
};

export type DiscordPingInteraction = {
  application_id?: string;
  id?: string;
  token?: string;
  type: 1;
};

export type DiscordApplicationCommandInteraction = {
  application_id: string;
  type: 2;
  id: string;
  token: string;
  data: DiscordCommandData;
};

export type DiscordInteraction =
  | DiscordPingInteraction
  | DiscordApplicationCommandInteraction;

export type SettingRecord = {
  atcoder_user_id: string | null;
  default_slot_minutes: number;
  default_problem_count: number;
  default_contest_duration_minutes: number;
  default_penalty_seconds: number;
  include_experimental_difficulty: number;
  include_abc: number;
  include_arc: number;
  include_agc: number;
  allow_other_sources: number;
  next_contest_sequence: number;
  exclude_recently_used_days: number;
  visibility: string;
  title_template: string | null;
  memo_template: string | null;
};

export type DifficultyBandRecord = {
  id?: number;
  setting_id?: number;
  sort_order?: number;
  difficulty_min: number;
  difficulty_max: number;
  problem_count: number;
};

export type CommandOptions = {
  atCoderProblemsToken?: string;
  contestCreationGuard?: DurableObjectNamespace;
  fetchFn?: typeof fetch;
  problemCatalogSync?: DurableObjectNamespace;
  submissionSync?: DurableObjectNamespace;
};
