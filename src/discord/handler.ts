import { handleDiscordCommand } from "./commands";
import type {
  DiscordApplicationCommandInteraction,
  DiscordInteraction,
  DiscordPingInteraction,
} from "./types";

const encoder = new TextEncoder();
const discordRequestToleranceMs = 5 * 60 * 1000;

const knownCommands = new Set(["start", "custom-start", "setting", "init"]);

type DiscordInteractionHandlerDependencies = {
  atCoderProblemsToken?: string;
  contestCreationGuard?: DurableObjectNamespace;
  database?: D1Database;
  executionCtx?: ExecutionContext;
  problemCatalogSync?: DurableObjectNamespace;
  publicKeyHex?: string;
  submissionSync?: DurableObjectNamespace;
};

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

  const timestampMs = Number(timestamp) * 1000;

  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > discordRequestToleranceMs
  ) {
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

const createDeferredResponse = () =>
  Response.json({
    type: 5,
  });

const editOriginalInteractionResponse = async (
  applicationId: string,
  interactionToken: string,
  content: string,
  fetchFn: typeof fetch = fetch,
) => {
  const response = await fetchFn(
    `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Discord follow-up failed with status ${response.status}.`);
  }
};

const extractResponseErrorMessage = async (response: Response) => {
  const body = await response.text();

  if (!body) {
    return "コマンド処理に失敗しました。";
  }

  try {
    const payload = JSON.parse(body) as {
      error?: string;
      message?: string;
    };

    return payload.error ?? payload.message ?? body;
  } catch {
    return body;
  }
};

export const createDiscordInteractionHandler =
  ({
    atCoderProblemsToken,
    contestCreationGuard,
    database,
    executionCtx,
    problemCatalogSync,
    publicKeyHex,
    submissionSync,
  }: DiscordInteractionHandlerDependencies) =>
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
      if (
        executionCtx &&
        (interaction.data.name === "start" ||
          interaction.data.name === "custom-start")
      ) {
        executionCtx.waitUntil(
          handleDiscordCommand(database, interaction, {
            atCoderProblemsToken,
            contestCreationGuard,
            problemCatalogSync,
            submissionSync,
          })
            .then(async (response) => {
              if (!response.ok) {
                await editOriginalInteractionResponse(
                  interaction.application_id,
                  interaction.token,
                  await extractResponseErrorMessage(response),
                );
                return;
              }

              const payload = (await response.json()) as {
                data?: { content?: string };
              };

              await editOriginalInteractionResponse(
                interaction.application_id,
                interaction.token,
                payload.data?.content ?? "コマンド処理が完了しました。",
              );
            })
            .catch(async (error) => {
              console.error("[discord] deferred command failed", {
                commandName: interaction.data.name,
                error: error instanceof Error ? error.message : error,
              });

              try {
                await editOriginalInteractionResponse(
                  interaction.application_id,
                  interaction.token,
                  error instanceof Error
                    ? error.message
                    : "コマンド処理に失敗しました。",
                );
              } catch (followupError) {
                console.error("[discord] deferred follow-up failed", {
                  commandName: interaction.data.name,
                  error:
                    followupError instanceof Error
                      ? followupError.message
                      : followupError,
                });
              }
            }),
        );

        return createDeferredResponse();
      }

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
