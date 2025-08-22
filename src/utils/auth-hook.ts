import { FastifyRequest, FastifyReply } from "fastify";
import { getAuthContext } from "./auth";

export async function authenticate(request: FastifyRequest, _: FastifyReply) {
  try {
    request.auth = (await getAuthContext(request));
  } catch (error) {
    request.log.error(error, "Authentication hook failed");
    request.auth = null;
  }
}
