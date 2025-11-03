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
  // Create a canonical metadata object from a URL so that
  // logically-equivalent URLs (e.g. different query param order)
  // produce the same metadata representation.
  private static buildCanonicalMetadata(u: string): { path: string; query: Record<string, string | string[]> } {
    const urlObject = new URL(u);
    // Collect all query param keys, then build a sorted map
    const keys = Array.from(new Set(Array.from(urlObject.searchParams.keys())));
    keys.sort();

    const queryParams: Record<string, string | string[]> = {};
    for (const key of keys) {
      const allValues = urlObject.searchParams.getAll(key).map(String);
      if (allValues.length <= 1) {
        queryParams[key] = allValues[0] ?? "";
      } else {
        // Normalize multi-value params by sorting and de-duplicating
        const deduped = Array.from(new Set(allValues));
        deduped.sort();
        queryParams[key] = deduped;
      }
    }

    return {
      path: urlObject.pathname,
      query: queryParams,
    };
  }

  // Shallow canonical comparison for metadata produced by buildCanonicalMetadata.
  // Accepts unknown shapes and attempts a best-effort normalization before compare.
  private static isSameConfig(a?: unknown, b?: unknown): boolean {
    try {
      const normalize = (m: any): { path: string; query: Record<string, string | string[]> } | null => {
        if (!m || typeof m !== "object") return null;
        const path = typeof m.path === "string" ? m.path : "";
        const querySrc = (m as any).query;
        const q: Record<string, string | string[]> = {};
        if (querySrc && typeof querySrc === "object") {
          const keys = Object.keys(querySrc).sort();
          for (const k of keys) {
            const v = (querySrc as any)[k];
            if (Array.isArray(v)) {
              const arr = v.map((x) => String(x));
              const deduped = Array.from(new Set(arr)).sort();
              q[k] = deduped;
            } else if (v == null) {
              q[k] = "";
            } else {
              q[k] = String(v);
            }
          }
        }
        return { path, query: q };
      };

      const na = normalize(a);
      const nb = normalize(b);
      if (!na || !nb) return false;
      if (na.path !== nb.path) return false;

      const keysA = Object.keys(na.query);
      const keysB = Object.keys(nb.query);
      if (keysA.length !== keysB.length) return false;
      for (const k of keysA) {
        if (!Object.prototype.hasOwnProperty.call(nb.query, k)) return false;
        const va = na.query[k];
        const vb = nb.query[k];
        if (Array.isArray(va) || Array.isArray(vb)) {
          const aa = Array.isArray(va) ? va : [String(va)];
          const bb = Array.isArray(vb) ? vb : [String(vb)];
          if (aa.length !== bb.length) return false;
          for (let i = 0; i < aa.length; i++) {
            if (aa[i] !== bb[i]) return false;
          }
        } else {
          if (va !== vb) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

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

    const canonical = this.buildCanonicalMetadata(url);
    const existing = await shortLinkRepository.getByCode(code);
    if (existing) {
      // If an entry already exists for this code and the original URL matches exactly,
      // delegate to repository to ensure user association is updated.
      if (existing.original_url === url) {
        const updated = await shortLinkRepository.createOrUpdate({
          code,
          userId,
          originalUrl: url,
          metadata: canonical,
        });
        return { success: true, code: updated.code };
      }
      // If the stored metadata represents the same logical configuration, reuse it
      // without creating a new record.
      if (this.isSameConfig(existing.metadata, canonical)) {
        return { success: true, code: existing.code };
      }
      // Same hash but different logical config => true collision
      return { success: false, error: "Hash collision detected. Cannot create short link.", status: 500 };
    }

    try {
      const newRecord = await shortLinkRepository.createOrUpdate({
        code,
        userId,
        originalUrl: url,
        metadata: canonical,
      });
      return { success: true, code: newRecord.code };
    } catch (err: any) {
      if (err instanceof ShortLinkCollisionError) {
        return { success: false, error: "Hash collision detected. Cannot create short link.", status: 500 };
      }
      // Handle potential race: if another process inserted the same code concurrently,
      // fetch it and reuse when config matches.
      try {
        const existingAfterError = await shortLinkRepository.getByCode(code);
        if (existingAfterError && (existingAfterError.original_url === url || this.isSameConfig(existingAfterError.metadata, canonical))) {
          return { success: true, code: existingAfterError.code };
        }
      } catch {}
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
