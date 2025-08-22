import { FastifyRequest, FastifyReply } from "fastify";
import { UnauthorizedError } from "./errors";
import { getAuthContext } from "./auth";

export async function authenticate(request: FastifyRequest, _: FastifyReply) {
  try {
    const auth = await getAuthContext(request);
    request.auth = auth;

    if (!auth) {
      throw new UnauthorizedError("Unauthorized")
    }
  } catch (error) {
    request.log.error(error, "Authentication hook failed");
    throw error;
  }
}
