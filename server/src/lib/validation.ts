import type { z } from 'zod';
import { badRequest } from './errors.js';

/** Converts Zod issues into a safe, field-addressed list for API error responses. */
export function zodDetails(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
}

export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown, message = 'Invalid request'): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest(message, zodDetails(result.error));
  return result.data;
}
