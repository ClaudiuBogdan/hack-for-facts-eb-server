import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../utils/auth-hook";
import { ShortLinkService } from "../services/short-link";
import { createShortLinkSchema, resolveShortLinkSchema } from "../schemas/short-links";

export default async function shortLinkRoutes(fastify: FastifyInstance) {
  await fastify.register(async function (fastify) {
    fastify.post(
      "/api/v1/short-links",
      {
        preHandler: [authenticate],
        schema: createShortLinkSchema,
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;
        if (!userId) return reply.code(401).send({ ok: false, error: "Unauthorized" });

        const rateLimitResult = await ShortLinkService.checkRateLimit(userId);
        if (!rateLimitResult.allowed) {
          return reply.code(429).send({ ok: false, error: rateLimitResult.error });
        }

        const validation = ShortLinkService.validateCreateRequest(request.body);
        if (!validation.success) {
          return reply.code(400).send({ ok: false, error: validation.error });
        }

        try {
          const result = await ShortLinkService.createShortLink(userId, validation.data.url);
          if (!result.success) {
            return reply.code(result.status).send({ ok: false, error: result.error });
          }
          return reply.code(200).send({ ok: true, data: { code: result.code } });
        } catch (err) {
          request.log.error(err, "Failed to create short link");
          return reply.code(500).send({ ok: false, error: "An unexpected error occurred." });
        }
      }
    );

    fastify.get(
      "/api/v1/short-links/:code",
      {
        schema: resolveShortLinkSchema,
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const validation = ShortLinkService.validateCodeParams(request.params);
        if (!validation.success) {
          return reply.code(400).send({ ok: false, error: validation.error });
        }

        const result = await ShortLinkService.resolveShortLink(validation.data.code);
        if (!result.success) {
          return reply.code(result.status).send({ ok: false, error: result.error });
        }

        return reply.code(200).send({ ok: true, data: { url: result.url } });
      }
    );
  });
}


