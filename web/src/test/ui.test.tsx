import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { validateProperty } from '../admin/PropertyFormPage';
import type { ChatMessage, PropertyCardItem } from '../lib/types';

type Handler = (body: unknown, init: RequestInit) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;
let routes: Record<string, Handler>;
const calls: { key: string; body: unknown }[] = [];

function mockFetch() {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.split('?')[0]!;
      const key = Object.keys(routes).find((k) => {
        const [m, p] = k.split(' ');
        return m === method && new RegExp(`^${p!.replace(/:\w+/g, '[^/]+')}$`).test(path);
      });
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key: `${method} ${path}`, body });
      if (!key) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 });
      const res = await routes[key]!(body, init);
      return new Response(JSON.stringify(res.json), { status: res.status ?? 200 });
    }),
  );
}

const property = (over: Partial<PropertyCardItem> = {}): PropertyCardItem => ({
  id: 'p1',
  index: 1,
  listing_code: 'CP-DEMO-001',
  title: '2BHK apartment for rent in Velachery',
  transaction_type: 'rent',
  property_type: 'apartment',
  locality: 'Velachery',
  city: 'Chennai',
  address_public: null,
  bedrooms: 2,
  bathrooms: 1,
  area_sqft: 1210,
  price_amount: 22000,
  price_period: 'monthly',
  price_label: '₹22,000/month',
  furnishing: 'semi_furnished',
  amenities: ['lift'],
  parking: 'available',
  pet_policy: 'unknown',
  availability_status: 'available',
  description: null,
  is_demo: true,
  updated_at: '2026-10-10T00:00:00Z',
  images: [],
  reasons: ['in Velachery', '2BHK'],
  caveats: [],
  ...over,
});

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: Math.random().toString(36).slice(2),
  direction: 'outbound',
  body: '',
  created_at: '2026-10-11T10:00:00Z',
  cards: [],
  retryable: false,
  ...over,
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  routes = {
    'POST /api/chat/sessions': () => ({ status: 201, json: { session_id: 's1', token: 't1' } }),
    'GET /api/chat/sessions/:id/messages': () => ({ json: { messages: [], requirements: { summary: [] }, shortlist: [] } }),
  };
  mockFetch();
});

describe('customer chat', () => {
  it('shows the demo-data notice and example prompts on an empty conversation', async () => {
    renderAt('/');
    expect(await screen.findByText(/Find your next home in Chennai/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/sample demonstration data/i);
  });

  it('sends a message and renders the reply with property cards', async () => {
    routes['POST /api/chat/sessions/:id/messages'] = (body) => ({
      status: 201,
      json: {
        inbound: msg({ id: 'in1', direction: 'inbound', body: (body as { text: string }).text }),
        reply: msg({
          id: 'out1',
          body: 'Here is 1 listing for rent, 2BHK, in Velachery',
          cards: [{ type: 'properties', items: [property()], total_matches: 1, applied_filters: ['for rent'], near_match: null }],
        }),
        requirements: { summary: ['for rent', '2BHK', 'in Velachery'] },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    const box = await screen.findByLabelText('Message');
    await user.type(box, '2BHK for rent in Velachery{Enter}');
    const card = await screen.findByRole('article', { name: /CP-DEMO-001/ });
    expect(within(card).getByText('₹22,000/month')).toBeInTheDocument();
    expect(within(card).getByText('Sample data')).toBeInTheDocument();
    expect(within(card).getByText('No photo yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Current search')).toHaveTextContent('in Velachery');
    const sent = calls.find((c) => c.key === 'POST /api/chat/sessions/s1/messages')!;
    expect(sent.body).toMatchObject({ text: '2BHK for rent in Velachery', client_message_id: expect.any(String) });
  });

  it('shows a loading state and prevents duplicate sends', async () => {
    let release!: () => void;
    routes['POST /api/chat/sessions/:id/messages'] = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ status: 201, json: { inbound: msg({ id: 'i', direction: 'inbound', body: 'hi' }), reply: msg({ id: 'o', body: 'Hello!' }), requirements: { summary: [] } } });
      });
    const user = userEvent.setup();
    renderAt('/');
    const box = await screen.findByLabelText('Message');
    await user.type(box, 'hi{Enter}');
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByLabelText('Assistant is typing')).toBeInTheDocument();
    await user.type(box, 'again{Enter}');
    expect(calls.filter((c) => c.key.startsWith('POST /api/chat/sessions/s1/messages'))).toHaveLength(1);
    release();
    expect(await screen.findByText('Hello!')).toBeInTheDocument();
  });

  it('keeps the message and offers retry when sending fails', async () => {
    routes['POST /api/chat/sessions/:id/messages'] = () => ({ status: 503, json: { error: { code: 'x', message: 'Service unavailable' } } });
    const user = userEvent.setup();
    renderAt('/');
    const box = await screen.findByLabelText('Message');
    await user.type(box, '2BHK in Adyar{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(box).toHaveValue('2BHK in Adyar');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders a zero-result reply with relaxation chips that send a follow-up', async () => {
    let n = 0;
    routes['POST /api/chat/sessions/:id/messages'] = (body) => ({
      status: 201,
      json: {
        inbound: msg({ id: `i${n}`, direction: 'inbound', body: (body as { text: string }).text }),
        reply: msg({
          id: `o${n++}`,
          body: n === 1 ? 'No stored listings match for rent, 5BHK.' : 'Updated.',
          cards: n === 1 ? [{ type: 'quick_replies', options: [{ label: 'Budget ₹12,000', message: 'Actually my budget is ₹12,000' }] }] : [],
        }),
        requirements: { summary: [] },
      },
    });
    const user = userEvent.setup();
    renderAt('/');
    await user.type(await screen.findByLabelText('Message'), '5BHK for rent{Enter}');
    expect(await screen.findByText(/No stored listings match/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Budget ₹12,000' }));
    await waitFor(() => expect(calls.at(-1)!.body).toMatchObject({ text: 'Actually my budget is ₹12,000' }));
  });

  it('validates the callback contact form before submitting', async () => {
    routes['GET /api/chat/sessions/:id/messages'] = () => ({
      json: {
        messages: [
          msg({
            id: 'o1',
            body: "I've passed a callback request",
            cards: [{ type: 'lead', lead: { id: 'l1', enquiry_type: 'callback', status: 'new', listing_code: 'CP-DEMO-001', preferred_time_text: null }, needs_contact: true }],
          }),
        ],
        requirements: { summary: [] },
      },
    });
    routes['POST /api/chat/sessions/:id/contact'] = () => ({ json: { name: 'Priya', phone_last4: '3210' } });
    localStorage.setItem('cp.chat.session', JSON.stringify({ id: 's1', token: 't1' }));
    const user = userEvent.setup();
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'Share my details' }));
    expect(screen.getByText('Enter a 10-digit Indian mobile number')).toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/contact'))).toBe(false);
    await user.type(screen.getByLabelText('Your name'), 'Priya');
    await user.type(screen.getByLabelText('Mobile number'), '9876543210');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Share my details' }));
    expect(await screen.findByText(/number ending 3210/)).toBeInTheDocument();
  });
});

describe('admin dashboard', () => {
  const meta = {
    localities: [{ name: 'Velachery', corridor: 'South' }],
    amenities: ['lift', 'gym'],
    enums: {
      transaction_type: ['rent', 'sale'],
      property_type: ['apartment', 'villa'],
      availability_status: ['available', 'pending_confirmation', 'unavailable', 'deactivated'],
      price_period: ['monthly', 'total', 'per_sqft', 'negotiable'],
      furnishing: ['unknown', 'furnished'],
      parking: ['unknown', 'available'],
      pet_policy: ['unknown', 'allowed'],
      lead_status: ['new', 'contacted', 'visit_requested', 'qualified', 'closed', 'spam'],
    },
  };
  const signedIn = () => {
    routes['GET /api/admin/auth/me'] = () => ({ json: { admin: { email: 'a@x.in', display_name: 'Anita', role: 'admin' } } });
    routes['GET /api/admin/meta'] = () => ({ json: meta });
  };

  it('shows the login screen when not authenticated', async () => {
    routes['GET /api/admin/auth/me'] = () => ({ status: 401, json: { error: { code: 'unauthorized', message: 'Authentication required' } } });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
  });

  it('shows overview counts from the API', async () => {
    signedIn();
    routes['GET /api/admin/overview'] = () => ({ json: { active_properties: 33, new_leads: 4, visit_requests: 2, total_leads: 9, demo_properties: 33 } });
    routes['GET /api/admin/leads'] = () => ({ json: { items: [], total: 0 } });
    renderAt('/admin');
    expect(await screen.findByText('33')).toBeInTheDocument();
    expect(screen.getByText('Visit requests (unconfirmed)').previousSibling).toHaveTextContent('2');
    expect(screen.getByText('No leads yet')).toBeInTheDocument();
  });

  it('validates the property form client-side', async () => {
    const e = validateProperty(
      { listing_code: 'x', title: 'ab', transaction_type: 'rent', property_type: 'apartment', locality: '', address_public: '', bedrooms: '99', bathrooms: '', area_sqft: '', price_amount: '-5', price_period: 'total', furnishing: 'unknown', parking: 'unknown', pet_policy: 'unknown', availability_status: 'available', amenities: [], description: '', image_urls: 'javascript:alert(1)' },
      true,
    );
    expect(Object.keys(e).sort()).toEqual(['bedrooms', 'image_urls', 'listing_code', 'locality', 'price_amount', 'price_period', 'title']);

    signedIn();
    const user = userEvent.setup();
    renderAt('/admin/properties/new');
    await user.click(await screen.findByRole('button', { name: 'Create listing' }));
    expect(screen.getByText('Please fix the highlighted fields.')).toBeInTheDocument();
    expect(screen.getByText('Enter a positive whole number of rupees')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/admin/properties')).toBe(false);
  });

  it('updates a lead status', async () => {
    signedIn();
    const lead = { id: 'l1', customer_id: 'c1', conversation_id: 'v1', property_id: null, enquiry_type: 'site_visit', status: 'visit_requested', preferred_time_text: 'Saturday 11am', preferred_visit_at: null, assigned_agent: null, notes: null, created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T10:00:00Z' };
    routes['GET /api/admin/leads/:id'] = () => ({
      json: { lead, customer: { id: 'c1', channel: 'web', display_name: 'Priya', phone: '9876543210', consent_status: 'granted', preferred_language: null }, property: null, requirements: { summary: ['for rent'], confidence: {} }, shortlist: [], recent_messages: [] },
    });
    routes['PATCH /api/admin/leads/:id'] = (body) => {
      Object.assign(lead, body);
      return { json: { lead } };
    };
    const user = userEvent.setup();
    renderAt('/admin/leads/l1');
    expect(await screen.findByText('Priya')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'contacted');
    await user.type(screen.getByLabelText('Assigned agent'), 'Anita');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'PATCH /api/admin/leads/l1')!.body).toMatchObject({ status: 'contacted', assigned_agent: 'Anita' });
  });
});
