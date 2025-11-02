import { ShortLinkService } from "../services/short-link";

/**
 * Creates a shareable short link for a given full client URL.
 * Falls back to the original URL on failure.
 */
export async function makeShareLink(
  fullUrl: string,
  options?: { userId?: string; context?: string }
): Promise<string> {
  const clientBase = (process.env.PUBLIC_CLIENT_BASE_URL || process.env.CLIENT_BASE_URL || "").replace(/\/$/, "");
  const userId = options?.userId || "mcp-system";

  try {
    const res = await ShortLinkService.createShortLink(userId, fullUrl);
    if (res && "success" in res && res.success && (res as any).code) {
      const code = (res as any).code as string;
      return `${clientBase || "https://transparenta.eu"}/share/${code}`;
    } else {
      // Non-throwing failure; log for diagnostics but return original URL
      const ctx = options?.context ? ` for ${options.context}` : "";
      // eslint-disable-next-line no-console
      console.warn(`Short link creation did not return success${ctx}:`, res);
      return fullUrl;
    }
  } catch (error) {
    const ctx = options?.context ? ` for ${options.context}` : "";
    // eslint-disable-next-line no-console
    console.error(
      `Failed to create short link${ctx}:`,
      error instanceof Error ? error.message : String(error)
    );
    return fullUrl;
  }
}

