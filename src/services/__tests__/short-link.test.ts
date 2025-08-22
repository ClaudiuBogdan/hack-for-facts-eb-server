import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ShortLinkService } from '../short-link';

describe('ShortLinkService', () => {

  describe('generateCode', () => {
    it('should generate a 16-character code for a URL', () => {
      const url = 'https://example.com/test';
      const code = ShortLinkService.generateCode(url);
      
      assert.strictEqual(code.length, 16);
      assert.match(code, /^[A-Za-z0-9_-]+$/);
    });

    it('should generate the same code for the same URL', () => {
      const url = 'https://example.com/test';
      const code1 = ShortLinkService.generateCode(url);
      const code2 = ShortLinkService.generateCode(url);
      
      assert.strictEqual(code1, code2);
    });

    it('should generate different codes for different URLs', () => {
      const url1 = 'https://example.com/test1';
      const url2 = 'https://example.com/test2';
      const code1 = ShortLinkService.generateCode(url1);
      const code2 = ShortLinkService.generateCode(url2);
      
      assert.notStrictEqual(code1, code2);
    });

    it('should generate different codes when salt is provided', () => {
      const url = 'https://example.com/test';
      const code1 = ShortLinkService.generateCode(url);
      const code2 = ShortLinkService.generateCode(url, 'salt');
      
      assert.notStrictEqual(code1, code2);
    });
  });

  describe('isApprovedClientUrl', () => {
    const originalEnv = process.env;

    it('should return true for URLs in ALLOWED_ORIGINS', () => {
      const backup = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://example.com,https://test.com';
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://example.com/path'), true);
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://test.com/path'), true);
      
      // Restore
      if (backup) {
        process.env.ALLOWED_ORIGINS = backup;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    });

    it('should return true for CLIENT_BASE_URL', () => {
      const backup = process.env.CLIENT_BASE_URL;
      process.env.CLIENT_BASE_URL = 'https://client.com';
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://client.com/path'), true);
      
      // Restore
      if (backup) {
        process.env.CLIENT_BASE_URL = backup;
      } else {
        delete process.env.CLIENT_BASE_URL;
      }
    });

    it('should return true for PUBLIC_CLIENT_BASE_URL', () => {
      const backup = process.env.PUBLIC_CLIENT_BASE_URL;
      process.env.PUBLIC_CLIENT_BASE_URL = 'https://public.com';
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://public.com/path'), true);
      
      // Restore
      if (backup) {
        process.env.PUBLIC_CLIENT_BASE_URL = backup;
      } else {
        delete process.env.PUBLIC_CLIENT_BASE_URL;
      }
    });

    it('should return false for non-approved URLs', () => {
      const backup = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://example.com';
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://malicious.com/path'), false);
      
      // Restore
      if (backup) {
        process.env.ALLOWED_ORIGINS = backup;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    });

    it('should return false for invalid URLs', () => {
      const backup = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://example.com';
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('not-a-url'), false);
      
      // Restore
      if (backup) {
        process.env.ALLOWED_ORIGINS = backup;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    });

    it('should handle empty environment variables', () => {
      const backupOrigins = process.env.ALLOWED_ORIGINS;
      const backupClient = process.env.CLIENT_BASE_URL;
      const backupPublic = process.env.PUBLIC_CLIENT_BASE_URL;
      
      delete process.env.ALLOWED_ORIGINS;
      delete process.env.CLIENT_BASE_URL;
      delete process.env.PUBLIC_CLIENT_BASE_URL;
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://example.com'), false);
      
      // Restore
      if (backupOrigins) process.env.ALLOWED_ORIGINS = backupOrigins;
      if (backupClient) process.env.CLIENT_BASE_URL = backupClient;
      if (backupPublic) process.env.PUBLIC_CLIENT_BASE_URL = backupPublic;
    });

    it('should trim whitespace from environment variables', () => {
      const backup = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = ' https://example.com , https://test.com ';
      
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://example.com/path'), true);
      assert.strictEqual(ShortLinkService.isApprovedClientUrl('https://test.com/path'), true);
      
      // Restore
      if (backup) {
        process.env.ALLOWED_ORIGINS = backup;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    });
  });

  describe('validateCreateRequest', () => {
    it('should validate correct URL', () => {
      const backup = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://example.com';
      
      const body = { url: 'https://example.com/test' };
      const result = ShortLinkService.validateCreateRequest(body);
      
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.url, 'https://example.com/test');
      }
      
      // Restore
      if (backup) {
        process.env.ALLOWED_ORIGINS = backup;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    });

    it('should reject invalid URL format', () => {
      const body = { url: 'not-a-url' };
      const result = ShortLinkService.validateCreateRequest(body);
      
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error, 'Invalid body');
      }
    });

    it('should reject URLs that are too long', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2_097_152);
      const body = { url: longUrl };
      const result = ShortLinkService.validateCreateRequest(body);
      
      assert.strictEqual(result.success, false);
    });

    it('should reject non-approved URLs', () => {
      const backup = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://example.com';
      
      const body = { url: 'https://malicious.com/test' };
      const result = ShortLinkService.validateCreateRequest(body);
      
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error, 'URL not allowed. Must match client base URL.');
      }
      
      // Restore
      if (backup) {
        process.env.ALLOWED_ORIGINS = backup;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    });

    it('should reject missing URL', () => {
      const body = {};
      const result = ShortLinkService.validateCreateRequest(body);
      
      assert.strictEqual(result.success, false);
    });

    it('should reject null body', () => {
      const result = ShortLinkService.validateCreateRequest(null);
      
      assert.strictEqual(result.success, false);
    });
  });

  describe('validateCodeParams', () => {
    it('should validate correct code', () => {
      const params = { code: 'abcdefghijklmnop' };
      const result = ShortLinkService.validateCodeParams(params);
      
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.code, 'abcdefghijklmnop');
      }
    });

    it('should reject code that is too short', () => {
      const params = { code: 'short' };
      const result = ShortLinkService.validateCodeParams(params);
      
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.error, 'Invalid code format');
      }
    });

    it('should reject code that is too long', () => {
      const params = { code: 'verylongcodethatexceedslimit' };
      const result = ShortLinkService.validateCodeParams(params);
      
      assert.strictEqual(result.success, false);
    });

    it('should reject missing code', () => {
      const params = {};
      const result = ShortLinkService.validateCodeParams(params);
      
      assert.strictEqual(result.success, false);
    });

    it('should reject null params', () => {
      const result = ShortLinkService.validateCodeParams(null);
      
      assert.strictEqual(result.success, false);
    });
  });
});