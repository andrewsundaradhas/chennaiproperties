import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../../db/client.js';
import { sha256 } from '../../lib/crypto.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { adminRepo, type AdminUser } from '../../repositories/admin.repo.js';
import { conversationsRepo, type Conversation } from '../../repositories/conversations.repo.js';
import { isUuid } from '../../repositories/properties.repo.js';

export const ADMIN_COOKIE = 'cp_admin';

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminUser;
    conversation?: Conversation;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function requireAdmin(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readCookie(req, ADMIN_COOKIE);
      if (!token) return next(unauthorized());
      const admin = await adminRepo.findSession(db, sha256(token));
      if (!admin) return next(unauthorized('Session expired — please sign in again'));
      req.admin = admin;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Web-chat session ownership: the anonymous bearer token issued at session creation must match.
 * A wrong token returns 404 (not 403) so session ids cannot be probed.
 */
export function requireChatSession(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = req.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const id = String(req.params.id ?? req.body?.session_id ?? '');
      if (!token) return next(unauthorized('Missing chat session token'));
      if (!isUuid(id)) return next(notFound('Chat session not found'));
      const conversation = await conversationsRepo.getByIdAndTokenHash(db, id, sha256(token));
      if (!conversation) return next(notFound('Chat session not found'));
      req.conversation = conversation;
      next();
    } catch (err) {
      next(err);
    }
  };
}
