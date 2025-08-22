export const errorResponseSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" }
  },
  required: ["ok", "error"],
  additionalProperties: false
} as const;

export const successResponseSchema = (dataSchema: any) => ({
  type: "object",
  properties: {
    ok: { type: "boolean" },
    data: dataSchema
  },
  required: ["ok", "data"],
  additionalProperties: false
} as const);

export const standardResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  404: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema
} as const;