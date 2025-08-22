import { FastifyRequest, FastifyReply } from "fastify";
import { UnauthorizedError } from "./errors";

export async function authenticate(request: FastifyRequest, _: FastifyReply) {
  try {
    // The mercurius plugin adds auth context. We just need to check if it's there.
    if (!request.auth) {
      throw new UnauthorizedError("Unauthorized")
    }
  } catch (error) {
    request.log.error(error, "Authentication hook failed");
    throw error;
  }
}
