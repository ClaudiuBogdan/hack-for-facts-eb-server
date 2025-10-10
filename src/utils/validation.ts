import type { ZodError } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export function formatZodError(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'root',
    message: issue.message,
    code: issue.code,
  }));
}

