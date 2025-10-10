export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

export class ValidationError extends Error {
  issues: Array<{ path: string; message: string; code: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string; code: string }> = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}