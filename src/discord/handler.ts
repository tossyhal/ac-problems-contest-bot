import { handleDiscordCommand } from "./commands";

const encoder = new TextEncoder();

const knownCommands = new Set(["start", "custom-start", "setting", "init"]);

type DiscordPingInteraction = {
  type: 1;
};

type DiscordApplicationCommandInteraction = {
  type: 2;
  data: {
    name: string;
  };
};

type DiscordInteraction =
  | DiscordPingInteraction
  | DiscordApplicationCommandInteraction;

const hexToUint8Array = (value: string) => {
  if (value.length % 2 !== 0) {
    throw new Error("Invalid hex string length.");
  }

  return Uint8Array.from(
    value.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
};

const importDiscordPublicKey = async (publicKeyHex: string) =>
  crypto.subtle.importKey(
    "raw",
    hexToUint8Array(publicKeyHex),
    {
      name: "Ed25519",
    },
    false,
    ["verify"],
  );

export const verifyDiscordRequest = async (
  request: Request,
  publicKeyHex: string,
) => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (!signature || !timestamp) {
    return null;
  }

  const body = await request.text();
  const publicKey = await importDiscordPublicKey(publicKeyHex);
  const isValid = await crypto.subtle.verify(
    "Ed25519",
    publicKey,
    hexToUint8Array(signature),
    encoder.encode(`${timestamp}${body}`),
  );

  if (!isValid) {
    return null;
  }

  return body;
};

const isPingInteraction = (
  interaction: DiscordInteraction,
): interaction is DiscordPingInteraction => interaction.type === 1;

const isApplicationCommandInteraction = (
  interaction: DiscordInteraction,
): interaction is DiscordApplicationCommandInteraction =>
  interaction.type === 2;

export const createDiscordInteractionHandler =
  (
    atCoderProblemsToken: string | undefined,
    contestCreationGuard: DurableObjectNamespace | undefined,
    publicKeyHex: string | undefined,
    database: D1Database | undefined,
    problemCatalogSync: DurableObjectNamespace | undefined,
    submissionSync?: DurableObjectNamespace,
  ) =>
  async (request: Request) => {
    if (!publicKeyHex) {
      return Response.json(
        {
          error: "DISCORD_PUBLIC_KEY is not configured.",
        },
        { status: 500 },
      );
    }

    const verifiedBody = await verifyDiscordRequest(request, publicKeyHex);

    if (!verifiedBody) {
      return Response.json(
        {
          error: "Invalid Discord signature.",
        },
        { status: 401 },
      );
    }

    const interaction = JSON.parse(verifiedBody) as DiscordInteraction;

    if (isPingInteraction(interaction)) {
      return Response.json({ type: 1 });
    }

    if (
      isApplicationCommandInteraction(interaction) &&
      knownCommands.has(interaction.data.name)
    ) {
      return handleDiscordCommand(database, interaction, {
        atCoderProblemsToken,
        contestCreationGuard,
        problemCatalogSync,
        submissionSync,
      });
    }

    return Response.json(
      {
        error: "Unsupported Discord interaction.",
      },
      { status: 400 },
    );
  };
