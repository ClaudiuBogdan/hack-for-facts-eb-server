import "fastify";

declare module "fastify" {
  export interface FastifyRequest {
    auth?: {
      userId: string;
    } | null;
  }
}
