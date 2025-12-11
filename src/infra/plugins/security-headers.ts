/**
 * Security Headers Plugin
 *
 * Configures HTTP security headers using @fastify/helmet.
 * SECURITY: SEC-003 - Adds standard security headers per OWASP recommendations.
 *
 * Headers configured:
 * - Content-Security-Policy: XSS/injection prevention
 * - X-Content-Type-Options: MIME sniffing prevention
 * - X-Frame-Options: Clickjacking prevention
 * - Strict-Transport-Security: HTTPS enforcement
 * - Referrer-Policy: Referrer leakage prevention
 * - X-DNS-Prefetch-Control: DNS prefetch control
 * - X-Permitted-Cross-Domain-Policies: Flash/PDF policy
 */

import helmet from '@fastify/helmet';

import type { AppConfig } from '../config/env.js';
import type { FastifyInstance } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default CSP directives for API-only server.
 * Restrictive by default - only allows same-origin resources.
 */
const DEFAULT_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  upgradeInsecureRequests: [] as string[],
} as const;

/**
 * Relaxed CSP directives for GraphiQL in development.
 * GraphiQL requires inline scripts and styles.
 */
const GRAPHIQL_CSP_DIRECTIVES = {
  ...DEFAULT_CSP_DIRECTIVES,
  // GraphiQL needs inline scripts and eval for code editor
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  // GraphiQL needs inline styles
  styleSrc: ["'self'", "'unsafe-inline'"],
  // GraphiQL may load from CDN in some configurations
  imgSrc: ["'self'", 'data:', 'https:'],
} as const;

/**
 * HSTS configuration.
 * 1 year max-age with subdomains included.
 */
const HSTS_CONFIG = {
  maxAge: 31536000, // 1 year in seconds
  includeSubDomains: true,
  preload: false, // Requires manual submission to preload list
};

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers HTTP security headers plugin.
 *
 * @param fastify - Fastify instance
 * @param config - Application configuration
 */
export async function registerSecurityHeaders(
  fastify: FastifyInstance,
  config: AppConfig
): Promise<void> {
  // Determine environment
  const { isProduction, isTest, isDevelopment } = config.server;

  // Skip in test environment for easier testing
  if (isTest) {
    fastify.log.debug('Security headers disabled in test environment');
    return;
  }

  // Use relaxed CSP in development (GraphiQL needs inline scripts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- helmet CSP types are overly strict, runtime values are safe
  const cspDirectives = (isDevelopment ? GRAPHIQL_CSP_DIRECTIVES : DEFAULT_CSP_DIRECTIVES) as any;

  await fastify.register(helmet, {
    // Content-Security-Policy
    // Controls which resources can be loaded
    contentSecurityPolicy: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- cspDirectives type is safe, helmet types are overly strict
      directives: cspDirectives,
    },

    // X-DNS-Prefetch-Control: off
    // Prevents browsers from prefetching DNS
    dnsPrefetchControl: { allow: false },

    // X-Frame-Options: DENY
    // Prevents clickjacking by blocking framing
    frameguard: { action: 'deny' },

    // Strict-Transport-Security
    // Enforces HTTPS connections
    hsts: isProduction ? HSTS_CONFIG : false,

    // X-Permitted-Cross-Domain-Policies: none
    // Prevents Flash/PDF from loading data
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },

    // Referrer-Policy: strict-origin-when-cross-origin
    // Controls referrer header leakage
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // X-XSS-Protection: 0
    // Disabled - modern browsers use CSP instead, and this can introduce vulnerabilities
    xssFilter: false,

    // Remove X-Powered-By header
    // Prevents technology fingerprinting
    hidePoweredBy: true,

    // X-Content-Type-Options: nosniff
    // Prevents MIME type sniffing
    // (enabled by default in helmet)

    // Cross-Origin-Embedder-Policy
    // Not needed for API server
    crossOriginEmbedderPolicy: false,

    // Cross-Origin-Opener-Policy
    // Not needed for API server
    crossOriginOpenerPolicy: false,

    // Cross-Origin-Resource-Policy
    // Allow cross-origin requests (API is meant to be called from different origins)
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  fastify.log.info(
    { environment: config.server.isProduction ? 'production' : 'development' },
    'Security headers plugin registered'
  );
}
