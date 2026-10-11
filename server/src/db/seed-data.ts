// DEMONSTRATION DATA ONLY. These are invented sample listings, not ChennaiProperties inventory.
// Codes are stable (CP-DEMO-001…) so tests and demo scripts can refer to them.
import type { PropertyInput } from '../domain/property.js';
import { PropertyInputSchema } from '../domain/property.js';

type Seed = Omit<PropertyInput, 'city' | 'images' | 'amenities' | 'furnishing' | 'parking' | 'pet_policy' | 'availability_status'> &
  Partial<Pick<PropertyInput, 'amenities' | 'furnishing' | 'parking' | 'pet_policy' | 'availability_status'>> & {
    image?: 'apartment-a' | 'apartment-b' | 'house' | 'villa' | 'plot' | 'office';
  };

const rent = (
  n: number,
  locality: string,
  bedrooms: number | null,
  price: number,
  extra: Partial<Seed> = {},
): Seed => ({
  listing_code: code(n),
  title: `${bedrooms ? `${bedrooms}BHK ` : ''}${extra.property_type === 'independent_house' ? 'house' : 'apartment'} for rent in ${locality}`,
  transaction_type: 'rent',
  property_type: 'apartment',
  locality,
  bedrooms,
  bathrooms: bedrooms ? Math.max(1, bedrooms - (bedrooms > 2 ? 0 : 1)) : null,
  area_sqft: bedrooms ? 450 + bedrooms * 380 : null,
  price_amount: price,
  price_period: 'monthly',
  address_public: `${locality}, Chennai (sample address)`,
  description: `Sample listing for demonstration. ${bedrooms ?? ''}${bedrooms ? 'BHK' : ''} in ${locality}.`.trim(),
  image: 'apartment-a',
  ...extra,
});

const sale = (
  n: number,
  locality: string,
  bedrooms: number | null,
  price: number,
  extra: Partial<Seed> = {},
): Seed => ({
  ...rent(n, locality, bedrooms, price, extra),
  title: `${bedrooms ? `${bedrooms}BHK ` : ''}${labelFor(extra.property_type ?? 'apartment')} for sale in ${locality}`,
  transaction_type: 'sale',
  price_period: 'total',
  area_sqft: bedrooms ? 500 + bedrooms * 420 : 2400,
  image: 'apartment-b',
  ...extra,
});

function labelFor(t: PropertyInput['property_type']) {
  return { apartment: 'apartment', independent_house: 'independent house', villa: 'villa', plot: 'plot', commercial: 'commercial space', other: 'property' }[t];
}
function code(n: number) {
  return `CP-DEMO-${String(n).padStart(3, '0')}`;
}

const SEEDS: Seed[] = [
  // --- Rentals: Velachery cluster (supports the PRD's main acceptance journey) ---
  rent(1, 'Velachery', 2, 22000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift', 'power_backup', 'security'] }),
  rent(2, 'Velachery', 2, 24500, { furnishing: 'furnished', parking: 'available', pet_policy: 'allowed', amenities: ['lift', 'security', 'gym'], image: 'apartment-b' }),
  rent(3, 'Velachery', 2, 19000, { furnishing: 'unfurnished', parking: 'not_available', pet_policy: 'not_allowed', image: undefined }),
  rent(4, 'Velachery', 2, 28000, { furnishing: 'furnished', parking: 'available', pet_policy: 'case_by_case', amenities: ['lift', 'power_backup', 'gym', 'swimming_pool', 'gated_community'] }),
  rent(5, 'Velachery', 2, 23000, { furnishing: 'furnished', parking: 'available', availability_status: 'pending_confirmation', amenities: ['lift', 'metro_nearby'] }),
  rent(6, 'Velachery', 2, 21000, { furnishing: 'semi_furnished', parking: 'available', availability_status: 'unavailable' }),
  rent(7, 'Velachery', 3, 35000, { furnishing: 'furnished', parking: 'available', pet_policy: 'allowed', amenities: ['lift', 'power_backup', 'security', 'clubhouse'] }),
  // --- Rentals: rest of Chennai ---
  rent(8, 'Adyar', 2, 32000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift', 'security'] }),
  rent(9, 'Adyar', 3, 55000, { furnishing: 'furnished', parking: 'available', pet_policy: 'allowed', amenities: ['lift', 'power_backup', 'security', 'garden'], image: 'apartment-b' }),
  rent(10, 'Besant Nagar', 1, 18000, { furnishing: 'unfurnished', parking: 'unknown' }),
  rent(11, 'Anna Nagar', 2, 26000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift', 'power_backup'] }),
  rent(12, 'Anna Nagar', 3, 45000, { property_type: 'independent_house', furnishing: 'unfurnished', parking: 'available', pet_policy: 'allowed', amenities: ['garden', 'water_supply_24x7'], image: 'house' }),
  rent(13, 'T. Nagar', 1, 16500, { furnishing: 'semi_furnished', parking: 'not_available', image: undefined }),
  rent(14, 'Perungudi', 2, 24000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['gated_community', 'security', 'power_backup'] }),
  rent(15, 'Sholinganallur', 2, 21000, { furnishing: 'furnished', parking: 'available', amenities: ['gym', 'swimming_pool', 'clubhouse', 'gated_community'], image: 'apartment-b' }),
  rent(16, 'Sholinganallur', 3, 30000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift', 'gym'] }),
  rent(17, 'Navalur', 2, 17000, { furnishing: 'unfurnished', parking: 'available' }),
  rent(18, 'Thoraipakkam', 1, 14000, { furnishing: 'furnished', parking: 'unknown', amenities: ['security'] }),
  rent(19, 'Porur', 2, 18500, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift'] }),
  rent(20, 'Tambaram', 2, 15000, { property_type: 'independent_house', furnishing: 'unfurnished', parking: 'available', pet_policy: 'allowed', image: 'house' }),
  rent(21, 'Medavakkam', 2, 16000, { furnishing: 'semi_furnished', parking: 'available' }),
  rent(22, 'Nungambakkam', null, 85000, { property_type: 'commercial', title: 'Office space for rent in Nungambakkam', furnishing: 'furnished', parking: 'available', amenities: ['lift', 'power_backup', 'security'], image: 'office' }),
  rent(23, 'Kilpauk', 2, 27000, { furnishing: 'furnished', parking: 'available', amenities: ['lift'] }),
  rent(24, 'Guindy', 1, 20000, { furnishing: 'furnished', parking: 'not_available', amenities: ['metro_nearby', 'security'] }),
  // --- Sales ---
  sale(25, 'Velachery', 2, 7800000, { furnishing: 'unfurnished', parking: 'available', amenities: ['lift', 'power_backup'] }),
  sale(26, 'Velachery', 3, 12500000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift', 'gym', 'swimming_pool'] }),
  sale(27, 'Adyar', 3, 24000000, { furnishing: 'semi_furnished', parking: 'available', amenities: ['lift', 'security'] }),
  sale(28, 'Anna Nagar', 4, 35000000, { property_type: 'independent_house', furnishing: 'unfurnished', parking: 'available', amenities: ['garden'], image: 'house' }),
  sale(29, 'Sholinganallur', 2, 6200000, { furnishing: 'unfurnished', parking: 'available', amenities: ['gated_community', 'clubhouse'] }),
  sale(30, 'Navalur', 3, 11000000, { property_type: 'villa', furnishing: 'unfurnished', parking: 'available', amenities: ['gated_community', 'garden', 'security'], image: 'villa' }),
  sale(31, 'Kelambakkam', null, 3500000, { property_type: 'plot', title: 'Residential plot for sale in Kelambakkam', area_sqft: 2400, bathrooms: null, image: 'plot' }),
  sale(32, 'Siruseri', 2, 4800000, { furnishing: 'unfurnished', parking: 'available', availability_status: 'pending_confirmation' }),
  sale(33, 'Porur', 2, 6900000, { price_period: 'negotiable', furnishing: 'semi_furnished', parking: 'available', image: undefined }),
  sale(34, 'Tambaram', 1, 3200000, { furnishing: 'unfurnished', parking: 'unknown' }),
  sale(35, 'Neelankarai', 4, 42000000, { property_type: 'villa', furnishing: 'furnished', parking: 'available', pet_policy: 'allowed', amenities: ['swimming_pool', 'garden', 'security'], image: 'villa' }),
  sale(36, 'Mylapore', 3, 19500000, { furnishing: 'semi_furnished', parking: 'available', availability_status: 'unavailable' }),
];

export const DEMO_PROPERTIES: PropertyInput[] = SEEDS.map(({ image, ...s }) =>
  PropertyInputSchema.parse({
    ...s,
    images: image
      ? [{ image_url: `/demo-images/${image}.svg`, alt_text: `Illustration (sample image) — ${s.title}` }]
      : [],
  }),
);

export const DEMO_FAQS = [
  {
    key: 'about_assistant',
    question: 'What is this assistant?',
    answer:
      'This is a demonstration of the ChennaiProperties AI assistant. Listings shown are sample data, not live inventory.',
  },
  {
    key: 'site_visits',
    question: 'How do site visits work?',
    answer:
      'I can record a site-visit request with your preferred time. A team member then contacts you to confirm — a visit is not booked until they confirm it.',
  },
  {
    key: 'callbacks',
    question: 'How do callbacks work?',
    answer:
      'When you request a callback, your enquiry and search preferences are shared with the ChennaiProperties team, who contact you directly.',
  },
  {
    key: 'data_use',
    question: 'What happens to my details?',
    answer:
      'Your messages and any contact details you share are stored so the team can follow up on your enquiry. Please do not share sensitive personal information in chat.',
  },
];
