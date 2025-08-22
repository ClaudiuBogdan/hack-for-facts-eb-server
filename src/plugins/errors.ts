import type { FastifyInstance } from "fastify";
import { UnauthorizedError } from "../utils/errors";

export async function registerErrorHandler(fastify: FastifyInstance) {

    fastify.setErrorHandler((error, request, reply) => {
        if (error instanceof UnauthorizedError) {
            reply.status(401).send({ ok: false, error: error.message || 'Unauthorized' });
            return;
        }

        // Add more error handling here

        request.log.error(error);
        reply.status(500).send({ ok: false, error: 'Internal Server Error' });
    });
}