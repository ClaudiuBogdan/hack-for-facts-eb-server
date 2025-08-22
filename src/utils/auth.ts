import type { FastifyRequest } from "fastify";
import { verifyToken } from "@clerk/backend";
import config from "../config";

export function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const sessionCookie = cookieHeader
      .split(";")
      .find((c) => c.trim().startsWith("__session="));
    if (sessionCookie) {
      const parts = sessionCookie.split("=");
      if (parts.length > 1) return parts[1];
    }
  }
  return null;
}

export async function getAuthContext(request: FastifyRequest): Promise<{ userId: string } | null> {
  if (!config.clerkJwtKey) return null;
  const token = extractToken(request);
  if (!token) return null;
  try {
    const payload = await verifyToken(token, {
      jwtKey: config.clerkJwtKey,
      authorizedParties: config.clerkAuthorizedParties?.length
        ? config.clerkAuthorizedParties
        : undefined,
    });
    return payload.sub ? { userId: payload.sub } : null;
  } catch (error: any) {
    request.log.debug({ error: error.message }, "JWT verification failed");
    return null;
  }
}


