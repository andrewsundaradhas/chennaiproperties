import type { EnquiryType, LeadStatus } from './enums.js';
import { formatPrice } from './format.js';
import { toPublicProperty, type Property, type PublicProperty } from './property.js';

/** Structured UI payloads attached to assistant messages. Built only from database records. */
export interface PropertyCardItem extends PublicProperty {
  index: number;
  price_label: string;
  reasons: string[];
  caveats: string[];
}

export type Card =
  | {
      type: 'properties';
      items: PropertyCardItem[];
      total_matches: number;
      applied_filters: string[];
      near_match: { explanation: string } | null;
    }
  | { type: 'property_detail'; item: PropertyCardItem }
  | { type: 'compare'; items: PropertyCardItem[] }
  | {
      type: 'lead';
      lead: {
        id: string;
        enquiry_type: EnquiryType;
        status: LeadStatus;
        listing_code: string | null;
        preferred_time_text: string | null;
      };
      needs_contact: boolean;
    }
  | { type: 'quick_replies'; options: { label: string; message: string }[] };

export function toCardItem(
  p: Property,
  index: number,
  extra: { reasons?: string[]; caveats?: string[] } = {},
): PropertyCardItem {
  const caveats = [...(extra.caveats ?? [])];
  if (p.availability_status === 'pending_confirmation' && !caveats.some((c) => /pending/i.test(c))) {
    caveats.push('Availability pending confirmation by the team');
  }
  if (p.availability_status === 'unavailable') caveats.push('Marked unavailable');
  return {
    ...toPublicProperty(p),
    index,
    price_label: formatPrice(p.price_amount, p.price_period),
    reasons: extra.reasons ?? [],
    caveats,
  };
}
