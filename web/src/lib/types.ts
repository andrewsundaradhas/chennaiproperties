// Mirrors of the API response shapes the UI uses.

export type TransactionType = 'rent' | 'sale';
export type AvailabilityStatus = 'available' | 'pending_confirmation' | 'unavailable' | 'deactivated';
export type LeadStatus = 'new' | 'contacted' | 'visit_requested' | 'qualified' | 'closed' | 'spam';
export type EnquiryType = 'callback' | 'site_visit' | 'general';

export interface PropertyCardItem {
  id: string;
  index: number;
  listing_code: string;
  title: string;
  transaction_type: TransactionType;
  property_type: string;
  locality: string;
  city: string;
  address_public: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area_sqft: number | null;
  price_amount: number;
  price_period: string;
  price_label: string;
  furnishing: string;
  amenities: string[];
  parking: string;
  pet_policy: string;
  availability_status: AvailabilityStatus;
  description: string | null;
  is_demo: boolean;
  updated_at: string;
  images: { image_url: string; alt_text: string | null }[];
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
      lead: { id: string; enquiry_type: EnquiryType; status: LeadStatus; listing_code: string | null; preferred_time_text: string | null };
      needs_contact: boolean;
    }
  | { type: 'quick_replies'; options: { label: string; message: string }[] };

export interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
  cards: Card[];
  retryable: boolean;
}

export interface RequirementsView {
  summary: string[];
}

export interface AdminProperty extends Omit<PropertyCardItem, 'index' | 'price_label' | 'reasons' | 'caveats'> {
  latitude: number | null;
  longitude: number | null;
  source_type: 'demo_seed' | 'manual' | 'csv_import';
  created_at: string;
  deactivated_at: string | null;
}

export interface LeadListItem {
  id: string;
  customer_id: string;
  conversation_id: string | null;
  property_id: string | null;
  enquiry_type: EnquiryType;
  status: LeadStatus;
  preferred_time_text: string | null;
  assigned_agent: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  listing_code: string | null;
  property_title: string | null;
}

export interface AdminMeta {
  localities: { name: string; corridor: string | null }[];
  amenities: string[];
  enums: Record<
    'transaction_type' | 'property_type' | 'availability_status' | 'price_period' | 'furnishing' | 'parking' | 'pet_policy' | 'lead_status',
    string[]
  >;
}
