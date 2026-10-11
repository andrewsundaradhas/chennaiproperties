export function formatInr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function formatPriceLabel(amount: number, period: string): string {
  const compact = amount >= 1e7 ? `₹${+(amount / 1e7).toFixed(2)} crore` : amount >= 1e5 ? `₹${+(amount / 1e5).toFixed(2)} lakh` : formatInr(amount);
  switch (period) {
    case 'monthly':
      return `${formatInr(amount)}/month`;
    case 'per_sqft':
      return `${formatInr(amount)}/sq.ft`;
    case 'negotiable':
      return `${compact} (negotiable)`;
    default:
      return compact;
  }
}
