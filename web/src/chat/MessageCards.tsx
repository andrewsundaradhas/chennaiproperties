import { useState, type FormEvent } from 'react';
import { PropertyCard, type CardActions } from '../components/PropertyCard';
import { Field, StatusBadge } from '../components/ui';
import { api, ApiError, humanise } from '../lib/api';
import type { Card, PropertyCardItem } from '../lib/types';

interface Props extends CardActions {
  cards: Card[];
  session: { id: string; token: string };
  isLatest: boolean;
}

export function MessageCards({ cards, session, isLatest, onAsk, disabled }: Props) {
  return (
    <>
      {cards.map((card, i) => {
        switch (card.type) {
          case 'properties':
            return (
              <div key={i} className="stack" style={{ width: '100%', gap: 8 }}>
                {card.near_match && (
                  <div className="alert alert-info near-match">
                    <strong>Near match:</strong> no exact match — these are {card.near_match.explanation}.
                  </div>
                )}
                <div className="cards">
                  {card.items.map((item) => (
                    <PropertyCard key={item.id} item={item} actions={{ onAsk, disabled }} />
                  ))}
                </div>
              </div>
            );
          case 'property_detail':
            return <PropertyCard key={i} item={card.item} actions={{ onAsk, disabled }} wide />;
          case 'compare':
            return <CompareTable key={i} items={card.items} />;
          case 'lead':
            return <LeadCard key={i} card={card} session={session} />;
          case 'quick_replies':
            return isLatest ? (
              <div key={i} className="chips" aria-label="Suggested replies">
                {card.options.map((o) => (
                  <button key={o.label} className="chip" disabled={disabled} onClick={() => onAsk(o.message)}>
                    {o.label}
                  </button>
                ))}
              </div>
            ) : null;
          default:
            return null;
        }
      })}
    </>
  );
}

function CompareTable({ items }: { items: PropertyCardItem[] }) {
  const rows: [string, (i: PropertyCardItem) => string][] = [
    ['Price', (i) => i.price_label],
    ['Locality', (i) => i.locality],
    ['Bedrooms', (i) => (i.bedrooms === null ? 'Not recorded' : `${i.bedrooms}BHK`)],
    ['Area', (i) => (i.area_sqft ? `${i.area_sqft.toLocaleString('en-IN')} sq.ft` : 'Not recorded')],
    ['Furnishing', (i) => (i.furnishing === 'unknown' ? 'Not recorded' : humanise(i.furnishing))],
    ['Parking', (i) => (i.parking === 'unknown' ? 'Not recorded' : humanise(i.parking))],
    ['Pets', (i) => (i.pet_policy === 'unknown' ? 'Not recorded' : humanise(i.pet_policy))],
    ['Amenities', (i) => (i.amenities.length ? i.amenities.map(humanise).join(', ') : 'None recorded')],
    ['Status', (i) => humanise(i.availability_status)],
  ];
  return (
    <div className="table-wrap" style={{ maxWidth: 640, width: '100%' }}>
      <table className="compare">
        <caption className="sr-only">Listing comparison</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            {items.map((i) => (
              <th key={i.id} scope="col" className="mono">
                {i.listing_code}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, get]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {items.map((i) => (
                <td key={i.id}>{get(i)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadCard({ card, session }: { card: Extract<Card, { type: 'lead' }>; session: { id: string; token: string } }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const { lead } = card;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Please enter your name';
    if (!/^(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/.test(phone.trim())) errs.phone = 'Enter a 10-digit Indian mobile number';
    if (!consent) errs.consent = 'Please confirm consent so the team can contact you';
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ phone_last4: string }>(`/api/chat/sessions/${session.id}/contact`, {
        body: { name, phone, consent },
        token: session.token,
      });
      setSaved(res.phone_last4);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your details. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel panel-pad stack" style={{ maxWidth: 460, width: '100%', gap: 10 }}>
      <div className="row">
        <strong>{lead.enquiry_type === 'site_visit' ? 'Site-visit request' : 'Callback request'}</strong>
        {lead.listing_code && <span className="mono muted">{lead.listing_code}</span>}
        <span className="spacer" />
        <StatusBadge status={lead.status} />
      </div>
      {lead.enquiry_type === 'site_visit' && (
        <p className="subtle">
          {lead.preferred_time_text ? `Requested time: ${lead.preferred_time_text}. ` : ''}Not confirmed yet — the team will contact you to
          confirm.
        </p>
      )}
      {card.needs_contact &&
        (saved ? (
          <div className="alert alert-ok" role="status">
            Thanks! The team will contact you on the number ending {saved}.
          </div>
        ) : (
          <form className="stack" style={{ gap: 8 }} onSubmit={submit} noValidate>
            <div className="grid-2">
              <Field label="Your name" error={fieldErrors.name}>
                {(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
              </Field>
              <Field label="Mobile number" error={fieldErrors.phone}>
                {(p) => (
                  <input {...p} className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="98765 43210" />
                )}
              </Field>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={fieldErrors.consent ? true : undefined} />
              <span>I agree to ChennaiProperties contacting me about this enquiry using these details.</span>
            </label>
            {fieldErrors.consent && <span className="field error">{fieldErrors.consent}</span>}
            {error && (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}
            <div>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Saving…' : 'Share my details'}
              </button>
            </div>
          </form>
        ))}
    </div>
  );
}
