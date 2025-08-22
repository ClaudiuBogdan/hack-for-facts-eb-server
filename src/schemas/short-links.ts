import { successResponseSchema, standardResponses } from "./common";

export const MAX_URL_LENGTH = 2_097_152; // 2MB for chrome compatibility
export const MAX_CODE_LENGTH = 16;

// Request body schemas
export const createShortLinkBodySchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      format: "uri",
      maxLength: MAX_URL_LENGTH,
      description: "The URL to shorten. Must be from an approved client domain."
    },
  },
  required: ["url"],
  additionalProperties: false
} as const;

// Params schemas
export const shortLinkParamsSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      minLength: MAX_CODE_LENGTH,
      maxLength: MAX_CODE_LENGTH,
      pattern: `^[A-Za-z0-9_-]{${MAX_CODE_LENGTH}}$`,
      description: "The 16-character short link code"
    }
  },
  required: ["code"],
  additionalProperties: false
} as const;

// Response data schemas
const shortLinkCodeDataSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      minLength: MAX_CODE_LENGTH,
      maxLength: MAX_CODE_LENGTH,
      description: "The generated short link code"
    }
  },
  required: ["code"],
  additionalProperties: false
} as const;

const shortLinkUrlDataSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      format: "uri",
      description: "The original URL"
    }
  },
  required: ["url"],
  additionalProperties: false
} as const;

// Complete route schemas
export const createShortLinkSchema = {
  operationId: "createShortLink",
  tags: ["Short Links"],
  summary: "Create a short link for a client-approved URL",
  description: "Creates a deterministic short link for approved URLs. Returns existing link if URL was previously shortened.",
  body: createShortLinkBodySchema,
  response: {
    200: successResponseSchema(shortLinkCodeDataSchema),
    ...standardResponses
  }
} as const;

export const resolveShortLinkSchema = {
  operationId: "resolveShortLink",
  tags: ["Short Links"],
  summary: "Resolve a short link code",
  description: "Resolves a short link code and returns the original URL. Increments access statistics.",
  params: shortLinkParamsSchema,
  response: {
    200: successResponseSchema(shortLinkUrlDataSchema),
    400: standardResponses[400],
    404: standardResponses[404]
  }
} as const;