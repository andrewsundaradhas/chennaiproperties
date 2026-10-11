import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DemoBadge, ErrorAlert, Field, Spinner, StatusBadge } from '../components/ui';
import { ApiError, formatDateTime, humanise } from '../lib/api';
import type { AdminProperty, ChatMessage, LeadListItem } from '../lib/types';
import { useAdmin, useAdminApi } from './AdminApp';
import { formatPriceLabel } from './format';

interface LeadDetail {
  lead: Omit<LeadListItem, 'customer_name' | 'customer_phone' | 'listing_code' | 'property_title'> & { preferred_visit_at: string | null };
  customer: {
    id: string;
    channel: string;
    display_name: string | null;
    phone: string | null;
    consent_status: string;
    preferred_language: string | null;
  } | null;
  property: AdminProperty | null;
  requirements: { summary: string[]; confidence: Record<string, string> } | null;
  shortlist: { id: string; listing_code: string; title: string }[];
  recent_messages: ChatMessage[];
}

export function Transcript({ messages }: { messages: ChatMessage[] }) {
  if (messages.length === 0) return <p className="subtle">No messages.</p>;
  return (
    <div className="transcript" aria-label="Conversation transcript">
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.direction === 'inbound' ? 'msg-in' : 'msg-out'}`}>
          <div className="bubble" style={{ fontSize: '0.88rem' }}>
            {m.body}
          </div>
          <span className="msg-meta">
            {m.direction === 'inbound' ? 'Customer' : 'Assistant'} · {formatDateTime(m.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function LeadDetailPage() {
  const { id } = useParams();
  const call = useAdminApi();
  const { meta } = useAdmin();
  const [data, setData] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [agent, setAgent] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await call<LeadDetail>(`/api/admin/leads/${id}`);
      setData(d);
      setStatus(d.lead.status);
      setAgent(d.lead.assigned_agent ?? '');
      setNotes(d.lead.notes ?? '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load lead');
    }
  }, [call, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await call(`/api/admin/leads/${id}`, {
        method: 'PATCH',
        body: { status, assigned_agent: agent.trim() || null, notes: notes.trim() || null },
      });
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  if (!data) return error ? <ErrorAlert error={error} onRetry={() => void load()} /> : <Spinner />;
  const { lead, customer, property, requirements } = data;

  return (
    <>
      <div className="page-head">
        <Link to="/admin/leads" className="btn btn-ghost btn-sm">
          ← Leads
        </Link>
        <h1 className="spacer">
          {humanise(lead.enquiry_type).replace(/^./, (c) => c.toUpperCase())} request
        </h1>
        <StatusBadge status={lead.status} />
      </div>
      <ErrorAlert error={error} />
      <div className="detail-grid">
        <div className="stack">
          <section className="panel panel-pad stack">
            <h2>Customer</h2>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{customer?.display_name ?? <span className="subtle">Not shared</span>}</dd>
              <dt>Phone</dt>
              <dd>{customer?.phone ? <a href={`tel:+91${customer.phone}`}>{customer.phone}</a> : <span className="subtle">Not shared yet</span>}</dd>
              <dt>Consent</dt>
              <dd>{humanise(customer?.consent_status ?? 'unknown')}</dd>
              <dt>Channel</dt>
              <dd>{customer?.channel ?? '—'}</dd>
              {customer?.preferred_language && (
                <>
                  <dt>Language</dt>
                  <dd>{customer.preferred_language}</dd>
                </>
              )}
              <dt>Received</dt>
              <dd>{formatDateTime(lead.created_at)}</dd>
              {lead.preferred_time_text && (
                <>
                  <dt>Requested time</dt>
                  <dd>
                    {lead.preferred_time_text} <span className="badge badge-warn">Not confirmed</span>
                  </dd>
                </>
              )}
            </dl>
          </section>

          <section className="panel panel-pad stack">
            <h2>Their latest search</h2>
            {requirements && requirements.summary.length > 0 ? (
              <div className="chips">
                {requirements.summary.map((s) => (
                  <span key={s} className="badge badge-primary">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <p className="subtle">No requirements captured.</p>
            )}
            {data.shortlist.length > 0 && (
              <p className="subtle">
                Shortlisted: {data.shortlist.map((s) => s.listing_code).join(', ')}
              </p>
            )}
          </section>

          <section className="panel panel-pad stack">
            <div className="row">
              <h2 className="spacer">Recent conversation</h2>
              {lead.conversation_id && (
                <Link className="btn btn-sm" to={`/admin/conversations/${lead.conversation_id}`}>
                  Full history
                </Link>
              )}
            </div>
            <Transcript messages={data.recent_messages} />
          </section>
        </div>

        <div className="stack">
          <form className="panel panel-pad stack" onSubmit={save}>
            <h2>Follow-up</h2>
            <Field label="Status">
              {(p) => (
                <select {...p} className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {meta.enums.lead_status.map((s) => (
                    <option key={s} value={s}>
                      {humanise(s)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Assigned agent">
              {(p) => <input {...p} className="input" value={agent} onChange={(e) => setAgent(e.target.value)} maxLength={120} />}
            </Field>
            <Field label="Notes" hint="Internal only — never shown to customers.">
              {(p) => <textarea {...p} className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />}
            </Field>
            {saved && (
              <div className="alert alert-ok" role="status">
                Saved.
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </form>

          <section className="panel panel-pad stack">
            <h2>Listing</h2>
            {property ? (
              <>
                <div className="row">
                  <span className="mono">{property.listing_code}</span>
                  <StatusBadge status={property.availability_status} />
                  {property.is_demo && <DemoBadge />}
                </div>
                <strong>{property.title}</strong>
                <span className="muted">
                  {formatPriceLabel(property.price_amount, property.price_period)} · {property.locality}
                </span>
                {property.availability_status !== 'deactivated' && (
                  <Link to={`/admin/properties/${property.id}`} className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
                    Edit listing
                  </Link>
                )}
              </>
            ) : (
              <p className="subtle">General enquiry — no specific listing.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export function ConversationPage() {
  const { id } = useParams();
  const call = useAdminApi();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ messages: ChatMessage[] }>(`/api/admin/conversations/${id}/messages`)
      .then((r) => setMessages(r.messages))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load conversation'));
  }, [call, id]);
  return (
    <>
      <div className="page-head">
        <button className="btn btn-ghost btn-sm" onClick={() => history.back()}>
          ← Back
        </button>
        <h1 className="spacer">Conversation</h1>
      </div>
      <p className="subtle">Viewing is recorded in the audit log.</p>
      <ErrorAlert error={error} />
      {messages ? <Transcript messages={messages} /> : !error && <Spinner />}
    </>
  );
}
