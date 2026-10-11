// Errors carry a safe, user-facing message. Anything else becomes a generic 500.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'invalid_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);
export const tooManyRequests = (message = 'Too many requests, please slow down') =>
  new AppError(429, 'rate_limited', message);
