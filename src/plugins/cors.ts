import type { FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import config from "../config";

function getAllowedOriginsSet(): Set<string> {
	const set = new Set<string>();
	const raw = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
	raw.forEach((u) => set.add(u));
	if (process.env.CLIENT_BASE_URL) set.add(process.env.CLIENT_BASE_URL.trim());
	if (process.env.PUBLIC_CLIENT_BASE_URL) set.add(process.env.PUBLIC_CLIENT_BASE_URL.trim());
	return set;
}

export async function registerCors(fastify: FastifyInstance) {
	const allowedOrigins = getAllowedOriginsSet();
	await fastify.register(fastifyCors, {
		origin: (origin, cb) => {
			// Allow server-to-server or same-origin requests
			if (!origin) return cb(null, true);
			// Allow everything in non-prod
			if (config.nodeEnv !== "production") return cb(null, true);

			if (allowedOrigins.has(origin)) return cb(null, true);
			return cb(new Error("CORS origin not allowed"), false);
		},
		methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS", "DELETE"],
		allowedHeaders: [
			"content-type",
			"x-requested-with",
			"authorization",
			"x-api-key",
			"accept",
			"mcp-session-id",
			"last-event-id",
		],
		exposedHeaders: ["content-length", "mcp-session-id", "Mcp-Session-Id"],
		credentials: true,
	});
}


