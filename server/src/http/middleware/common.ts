import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, tooManyRequests } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  const start = Date.now();
  res.on('finish', () => {
    // Path only — no query strings or bodies, which may contain personal data.
    logger.info('http.request', {
      requestId: req.requestId,
      method: req.method,
      path: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
  });
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  next();
}

export function cors(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin && origin === allowedOrigin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-request-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Simple fixed-window limiter. In-memory is fine here: it is not a source of truth. */
export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DISABLE_RATE_LIMIT === 'true') return next();
    const now = Date.now();
    const key = `${req.ip}`;
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      return next();
    }
    entry.count++;
    if (entry.count > opts.max) {
      logger.warn('http.rate_limited', { requestId: req.requestId, limiter: opts.name });
      return next(tooManyRequests());
    }
    next();
  };
}

/** Admin mutations must be JSON: blocks cross-site HTML form posts riding on the cookie. */
export function requireJsonForMutations(req: Request, _res: Response, next: NextFunction) {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return next(new AppError(415, 'unsupported_media_type', 'Requests must be application/json'));
  }
  next();
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found', requestId: req.requestId } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.requestId },
    });
    return;
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body', requestId: req.requestId } });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large', requestId: req.requestId } });
    return;
  }
  // Unexpected: log the detail server-side, return a generic message (no stack, no SQL).
  logger.error('http.unhandled_error', {
    requestId: req.requestId,
    name: (err as Error)?.name,
    message: (err as Error)?.message,
    code: (err as { code?: string })?.code,
  });
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.', requestId: req.requestId } });
}
