export const booleanLabel = (value: number) => (value ? "ON" : "OFF");

export const formatTimestamp = (value: number | null) =>
  value ? new Date(value).toISOString() : "未実行";

export const createResponse = (content: string) =>
  Response.json({
    type: 4,
    data: {
      content,
    },
  });
