import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { shortLinkRepository, ShortLinkCollisionError } from "../db/repositories";
import { authenticate } from "../utils/auth-hook";

const MAX_URL_LENGTH = 2_097_152; // 2MB for chrome compatibility

const MAX_CODE_LENGTH = 16;

const createSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
});

const codeParamsSchema = z.object({
  code: z.string().length(MAX_CODE_LENGTH),
});

function generateCode(url: string, salt: string = ""): string {
  // Stage 1: SHA-512 for maximum entropy from input
  const intermediateHash = createHash("sha512").update(url + salt).digest("hex");

  // Stage 2: SHA-256 for final code generation
  const finalHash = createHash("sha256").update(intermediateHash).digest("base64url");
  return finalHash.substring(0, MAX_CODE_LENGTH);
}

function isApprovedClientUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const allowed = new Set<string>();
    const origins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    origins.forEach((o) => allowed.add(o));
    if (process.env.CLIENT_BASE_URL) allowed.add(process.env.CLIENT_BASE_URL.trim());
    if (process.env.PUBLIC_CLIENT_BASE_URL) allowed.add(process.env.PUBLIC_CLIENT_BASE_URL.trim());
    const origin = `${url.protocol}//${url.host}`;
    return allowed.has(origin);
  } catch {
    return false;
  }
}

export default async function shortLinkRoutes(fastify: FastifyInstance) {
  await fastify.register(async function (fastify) {
    fastify.post(
      "/api/v1/short-links",
      {
        preHandler: [authenticate],
        schema: {
          operationId: "createShortLink",
          tags: ["Short Links"],
          summary: "Create a short link for a client-approved URL",
          description: "Creates a deterministic short link for approved URLs. Returns existing link if URL was previously shortened.",
          body: {
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
          },
          response: {
            200: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                data: {
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
                },
              },
              required: ["ok", "data"],
              additionalProperties: false
            },
            400: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" }
              },
              required: ["ok", "error"]
            },
            401: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" }
              },
              required: ["ok", "error"]
            },
            429: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" }
              },
              required: ["ok", "error"]
            },
            500: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" }
              },
              required: ["ok", "error"]
            }
          },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;
        if (!userId) return reply.code(401).send({ ok: false, error: "Unauthorized" });

        // Rate limit check
        const limit = parseInt(process.env.SHORT_LINK_DAILY_LIMIT || "100", 10);
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
        const count = await shortLinkRepository.countRecentLinksForUser(userId, since);
        if (count >= limit) {
          return reply.code(429).send({ ok: false, error: "Daily limit reached for creating short links." });
        }

        const parsed = createSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, error: "Invalid body", details: parsed.error.format() });
        const { url } = parsed.data;
        if (!isApprovedClientUrl(url)) {
          return reply.code(400).send({ ok: false, error: "URL not allowed. Must match client base URL." });
        }

        // Generate a deterministic code
        const code = generateCode(url);

        // Check for a hash collision. This is rare, but a critical safeguard.
        const existing = await shortLinkRepository.getByCode(code);
        if (existing && existing.original_url !== url) {
          // This indicates a hash collision and is a server-side issue.
          return reply.code(500).send({ ok: false, error: "Hash collision detected. Cannot create short link." });
        }

        const urlObject = new URL(url);
        const queryParams: Record<string, string | string[]> = {};
        for (const key of new Set(Array.from(urlObject.searchParams.keys()))) {
          const values = urlObject.searchParams.getAll(key);
          queryParams[key] = values.length > 1 ? values : values[0];
        }
        const finalMetadata = {
          path: urlObject.pathname,
          query: queryParams,
        };

        try {
          const newRecord = await shortLinkRepository.createOrUpdate({
            code,
            userId,
            originalUrl: url,
            metadata: finalMetadata,
          });
          return reply.code(200).send({ ok: true, data: { code: newRecord.code } });
        } catch (err) {
          if (err instanceof ShortLinkCollisionError) {
            return reply.code(500).send({ ok: false, error: "Hash collision detected. Cannot create short link." });
          }
          // Log other errors
          request.log.error(err, "Failed to create short link");
          return reply.code(500).send({ ok: false, error: "An unexpected error occurred." });
        }
      }
    );

    fastify.get(
      "/api/v1/short-links/:code",
      {
        schema: {
          operationId: "resolveShortLink",
          tags: ["Short Links"],
          summary: "Resolve a short link code",
          description: "Resolves a short link code and returns the original URL. Increments access statistics.",
          params: {
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
          },
          response: {
            200: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                data: {
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
                }
              },
              required: ["ok", "data"],
              additionalProperties: false
            },
            400: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" }
              },
              required: ["ok", "error"]
            },
            404: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                error: { type: "string" }
              },
              required: ["ok", "error"]
            }
          },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = codeParamsSchema.safeParse(request.params);
        if (!parsed.success) {
          return reply.code(400).send({ ok: false, error: "Invalid code format" });
        }
        const { code } = parsed.data;

        const link = await shortLinkRepository.getByCode(code);
        if (!link) return reply.code(404).send({ ok: false, error: "Short link not found" });

        // Fire-and-forget stats update
        shortLinkRepository.incrementAccessStats(code).catch((err) => {
          request.log.error(err, `Failed to increment access stats for code ${code}`);
        });

        return reply.code(200).send({ ok: true, data: { url: link.original_url } });
      }
    );
  });
}


