import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import config from "../config";

export async function registerRateLimit(fastify: FastifyInstance) {
	await fastify.register(rateLimit, {
		max: (req, _res) => {
			const headerName = config.specialRateLimitHeader;
			const provided = String(req.headers[headerName] || "").trim();
			if (provided && config.specialRateLimitKey && provided === config.specialRateLimitKey) {
				return config.specialRateLimitMax;
			}
			return config.rateLimitMax;
		},
		timeWindow: config.rateLimitTimeWindow,
		keyGenerator: (req) => {
			// Prefer API key identity when present; fallback to IP
			const headerName = config.specialRateLimitHeader;
			const provided = String(req.headers[headerName] || "").trim();
			if (provided) return `apiKey:${provided}`;
			return req.ip;
		},
	});
}


