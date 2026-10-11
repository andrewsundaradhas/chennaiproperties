import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DemoBadge, ErrorAlert, Field, Spinner } from '../components/ui';
import { ApiError, humanise } from '../lib/api';
import type { AdminProperty } from '../lib/types';
import { useAdmin, useAdminApi } from './AdminApp';

interface FormState {
  listing_code: string;
  title: string;
  transaction_type: string;
  property_type: string;
  locality: string;
  address_public: string;
  bedrooms: string;
  bathrooms: string;
  area_sqft: string;
  price_amount: string;
  price_period: string;
  furnishing: string;
  parking: string;
  pet_policy: string;
  availability_status: string;
  amenities: string[];
  description: string;
  image_urls: string;
}

const EMPTY: FormState = {
  listing_code: '',
  title: '',
  transaction_type: 'rent',
  property_type: 'apartment',
  locality: '',
  address_public: '',
  bedrooms: '',
  bathrooms: '',
  area_sqft: '',
  price_amount: '',
  price_period: 'monthly',
  furnishing: 'unknown',
  parking: 'unknown',
  pet_policy: 'unknown',
  availability_status: 'available',
  amenities: [],
  description: '',
  image_urls: '',
};

function fromProperty(p: AdminProperty): FormState {
  return {
    listing_code: p.listing_code,
    title: p.title,
    transaction_type: p.transaction_type,
    property_type: p.property_type,
    locality: p.locality,
    address_public: p.address_public ?? '',
    bedrooms: p.bedrooms?.toString() ?? '',
    bathrooms: p.bathrooms?.toString() ?? '',
    area_sqft: p.area_sqft?.toString() ?? '',
    price_amount: String(p.price_amount),
    price_period: p.price_period,
    furnishing: p.furnishing,
    parking: p.parking,
    pet_policy: p.pet_policy,
    availability_status: p.availability_status,
    amenities: p.amenities,
    description: p.description ?? '',
    image_urls: p.images.map((i) => i.image_url).join('\n'),
  };
}

const intOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

export function validateProperty(f: FormState, isNew: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (isNew && !/^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(f.listing_code.trim())) e.listing_code = '3–40 letters, digits or dashes';
  if (f.title.trim().length < 3) e.title = 'Title must be at least 3 characters';
  if (!f.locality) e.locality = 'Choose a locality';
  const price = Number(f.price_amount);
  if (!f.price_amount.trim() || !Number.isInteger(price) || price <= 0) e.price_amount = 'Enter a positive whole number of rupees';
  if (f.transaction_type === 'rent' && f.price_period === 'total') e.price_period = 'Rentals use a monthly price';
  if (f.transaction_type === 'sale' && f.price_period === 'monthly') e.price_period = 'Sale listings cannot be priced monthly';
  for (const k of ['bedrooms', 'bathrooms'] as const) {
    const v = intOrNull(f[k]);
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 20)) e[k] = 'Whole number from 0 to 20';
  }
  const area = intOrNull(f.area_sqft);
  if (area !== null && (!Number.isInteger(area) || area <= 0)) e.area_sqft = 'Positive whole number';
  const badUrl = f.image_urls.split('\n').map((s) => s.trim()).filter(Boolean).find((u) => !/^(https?:\/\/|\/)\S+$/.test(u));
  if (badUrl) e.image_urls = `Not a valid image URL: ${badUrl}`;
  return e;
}

export function PropertyFormPage() {
  const { id } = useParams();
  const isNew = !id;
  const call = useAdminApi();
  const { meta } = useAdmin();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [original, setOriginal] = useState<AdminProperty | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) return;
    call<{ property: AdminProperty }>(`/api/admin/properties/${id}`)
      .then((r) => {
        setOriginal(r.property);
        setForm(fromProperty(r.property));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load listing'))
      .finally(() => setLoading(false));
  }, [call, id, isNew]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const v = validateProperty(form, isNew);
    setErrors(v);
    if (Object.keys(v).length) {
      setError('Please fix the highlighted fields.');
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      ...(isNew ? { listing_code: form.listing_code.trim() } : {}),
      title: form.title.trim(),
      transaction_type: form.transaction_type,
      property_type: form.property_type,
      locality: form.locality,
      address_public: form.address_public.trim() || null,
      bedrooms: intOrNull(form.bedrooms),
      bathrooms: intOrNull(form.bathrooms),
      area_sqft: intOrNull(form.area_sqft),
      price_amount: Number(form.price_amount),
      price_period: form.price_period,
      furnishing: form.furnishing,
      parking: form.parking,
      pet_policy: form.pet_policy,
      availability_status: form.availability_status,
      amenities: form.amenities,
      description: form.description.trim() || null,
      images: form.image_urls
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((image_url) => ({ image_url })),
    };
    try {
      if (isNew) await call('/api/admin/properties', { body });
      else await call(`/api/admin/properties/${id}`, { method: 'PATCH', body });
      navigate('/admin/properties');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.field.split('.')[0]!, d.message])));
      } else setError('Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  const select = (k: keyof FormState, options: string[], label: string) => (
    <Field label={label} error={errors[k]}>
      {(p) => (
        <select {...p} className="input" value={form[k] as string} onChange={(e) => set(k, e.target.value as never)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {humanise(o)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  const text = (k: keyof FormState, label: string, extra: { type?: string; hint?: string; inputMode?: 'numeric' } = {}) => (
    <Field label={label} error={errors[k]} hint={extra.hint}>
      {(p) => <input {...p} className="input" type={extra.type ?? 'text'} inputMode={extra.inputMode} value={form[k] as string} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="page-head">
        <Link to="/admin/properties" className="btn btn-ghost btn-sm">
          ← Properties
        </Link>
        <h1 className="spacer">{isNew ? 'Add listing' : `Edit ${original?.listing_code}`}</h1>
        {original?.is_demo && <DemoBadge />}
      </div>
      <ErrorAlert error={error} />
      <section className="panel panel-pad stack">
        <h2>Basics</h2>
        <div className="grid-3">
          {isNew ? text('listing_code', 'Listing code', { hint: 'Unique, e.g. CP-2024-001' }) : (
            <div className="field">
              <label>Listing code</label>
              <span className="mono" style={{ padding: '8px 0' }}>{form.listing_code}</span>
            </div>
          )}
          {select('transaction_type', meta.enums.transaction_type, 'Transaction')}
          {select('property_type', meta.enums.property_type, 'Property type')}
        </div>
        {text('title', 'Title')}
        <div className="grid-2">
          <Field label="Locality" error={errors.locality}>
            {(p) => (
              <select {...p} className="input" value={form.locality} onChange={(e) => set('locality', e.target.value)}>
                <option value="">Choose…</option>
                {meta.localities.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                    {l.corridor ? ` (${l.corridor})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {text('address_public', 'Public address / landmark', { hint: 'Shown to customers. Do not enter a precise address unless approved.' })}
        </div>
      </section>

      <section className="panel panel-pad stack">
        <h2>Price &amp; size</h2>
        <div className="grid-3">
          {text('price_amount', 'Price (₹)', { inputMode: 'numeric', hint: form.transaction_type === 'rent' ? 'Monthly rent' : 'Total price in rupees' })}
          {select('price_period', meta.enums.price_period, 'Price period')}
          {select('availability_status', meta.enums.availability_status.filter((s) => s !== 'deactivated'), 'Availability')}
          {text('bedrooms', 'Bedrooms (BHK)', { inputMode: 'numeric' })}
          {text('bathrooms', 'Bathrooms', { inputMode: 'numeric' })}
          {text('area_sqft', 'Area (sq.ft)', { inputMode: 'numeric' })}
        </div>
      </section>

      <section className="panel panel-pad stack">
        <h2>Features</h2>
        <p className="subtle">Leave as “unknown” when not confirmed — the assistant will tell customers it isn't recorded.</p>
        <div className="grid-3">
          {select('furnishing', meta.enums.furnishing, 'Furnishing')}
          {select('parking', meta.enums.parking, 'Parking')}
          {select('pet_policy', meta.enums.pet_policy, 'Pet policy')}
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field" style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
            Amenities (confirmed only)
          </legend>
          <div className="amenity-grid">
            {meta.amenities.map((a) => (
              <label key={a} className="checkbox">
                <input
                  type="checkbox"
                  checked={form.amenities.includes(a)}
                  onChange={(e) => set('amenities', e.target.checked ? [...form.amenities, a] : form.amenities.filter((x) => x !== a))}
                />
                <span>{humanise(a)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Description" error={errors.description}>
          {(p) => <textarea {...p} className="input" rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <Field label="Image URLs" error={errors.image_urls} hint="One per line: https://… or a site path like /demo-images/house.svg">
          {(p) => <textarea {...p} className="input mono" rows={3} value={form.image_urls} onChange={(e) => set('image_urls', e.target.value)} />}
        </Field>
      </section>

      <div className="row">
        <span className="spacer" />
        <Link to="/admin/properties" className="btn">
          Cancel
        </Link>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create listing' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
