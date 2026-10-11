import type { PricePeriod } from './enums.js';

/** Indian digit grouping: 2500000 -> "25,00,000". */
export function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

/** Compact form for sale prices: 7500000 -> "₹75 lakh", 21000000 -> "₹2.1 crore". */
export function formatInrCompact(amount: number): string {
  if (amount >= 1_00_00_000) return `₹${trim(amount / 1_00_00_000)} crore`;
  if (amount >= 1_00_000) return `₹${trim(amount / 1_00_000)} lakh`;
  return formatInr(amount);
}

const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, '');

export function formatPrice(amount: number, period: PricePeriod): string {
  switch (period) {
    case 'monthly':
      return `${formatInr(amount)}/month`;
    case 'total':
      return formatInrCompact(amount);
    case 'per_sqft':
      return `${formatInr(amount)}/sq.ft`;
    case 'negotiable':
      return `${formatInrCompact(amount)} (negotiable)`;
  }
}

export function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}
