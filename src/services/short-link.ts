import { createHash } from "crypto";
import { z } from "zod";
import { shortLinkRepository, ShortLinkCollisionError } from "../db/repositories";
import { MAX_URL_LENGTH, MAX_CODE_LENGTH } from "../schemas/short-links";

const createSchema = z.object({
  url: z.string().url().max(MAX_URL_LENGTH),
});

const codeParamsSchema = z.object({
  code: z.string().length(MAX_CODE_LENGTH),
});

export class ShortLinkService {
  static generateCode(url: string, salt: string = ""): string {
    const intermediateHash = createHash("sha512").update(url + salt).digest("hex");
    const finalHash = createHash("sha256").update(intermediateHash).digest("base64url");
    return finalHash.substring(0, MAX_CODE_LENGTH);
  }

  static isApprovedClientUrl(u: string): boolean {
    try {
      const url = new URL(u);
      const allowed = new Set<string>();
      const origins = (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      origins.forEach((o) => allowed.add(o));
      if (process.env.CLIENT_BASE_URL) allowed.add(process.env.CLIENT_BASE_URL.trim());
      if (process.env.PUBLIC_CLIENT_BASE_URL) allowed.add(process.env.PUBLIC_CLIENT_BASE_URL.trim());
      const origin = `${url.protocol}//${url.host}`;
      return allowed.has(origin);
    } catch {
      return false;
    }
  }

  static async checkRateLimit(userId: string): Promise<{ allowed: boolean; error?: string }> {
    const limit = parseInt(process.env.SHORT_LINK_DAILY_LIMIT || "100", 10);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await shortLinkRepository.countRecentLinksForUser(userId, since);
    
    if (count >= limit) {
      return { allowed: false, error: "Daily limit reached for creating short links." };
    }
    
    return { allowed: true };
  }

  static validateCreateRequest(body: unknown): { success: true; data: { url: string } } | { success: false; error: string } {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return { success: false, error: "Invalid body" };
    }
    
    const { url } = parsed.data;
    if (!this.isApprovedClientUrl(url)) {
      return { success: false, error: "URL not allowed. Must match client base URL." };
    }
    
    return { success: true, data: { url } };
  }

  static validateCodeParams(params: unknown): { success: true; data: { code: string } } | { success: false; error: string } {
    const parsed = codeParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: "Invalid code format" };
    }
    
    return { success: true, data: parsed.data };
  }

  static async createShortLink(userId: string, url: string): Promise<{ success: true; code: string } | { success: false; error: string; status: number }> {
    const code = this.generateCode(url);

    const existing = await shortLinkRepository.getByCode(code);
    if (existing && existing.original_url !== url) {
      return { success: false, error: "Hash collision detected. Cannot create short link.", status: 500 };
    }

    const urlObject = new URL(url);
    const queryParams: Record<string, string | string[]> = {};
    for (const key of new Set(Array.from(urlObject.searchParams.keys()))) {
      const values = urlObject.searchParams.getAll(key);
      queryParams[key] = values.length > 1 ? values : values[0];
    }
    const finalMetadata = {
      path: urlObject.pathname,
      query: queryParams,
    };

    try {
      const newRecord = await shortLinkRepository.createOrUpdate({
        code,
        userId,
        originalUrl: url,
        metadata: finalMetadata,
      });
      return { success: true, code: newRecord.code };
    } catch (err) {
      if (err instanceof ShortLinkCollisionError) {
        return { success: false, error: "Hash collision detected. Cannot create short link.", status: 500 };
      }
      throw err;
    }
  }

  static async resolveShortLink(code: string): Promise<{ success: true; url: string } | { success: false; error: string; status: number }> {
    const link = await shortLinkRepository.getByCode(code);
    if (!link) {
      return { success: false, error: "Short link not found", status: 404 };
    }

    // Fire-and-forget stats update
    shortLinkRepository.incrementAccessStats(code).catch(() => {
      // Silently fail - stats are not critical
    });

    return { success: true, url: link.original_url };
  }
}