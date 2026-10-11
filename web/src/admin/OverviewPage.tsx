import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChannelBadge, EmptyState, ErrorAlert, Spinner, StatusBadge } from '../components/ui';
import { ApiError, formatDateTime, humanise } from '../lib/api';
import type { LeadListItem } from '../lib/types';
import { useAdminApi } from './AdminApp';

interface Overview {
  active_properties: number;
  new_leads: number;
  visit_requests: number;
  total_leads: number;
  demo_properties: number;
  telegram:
    | { state: 'running'; username: string; mode: string }
    | { state: 'waiting_for_lease'; username: string }
    | { state: 'starting' }
    | { state: 'disabled' | 'error'; reason: string }
    | null;
}

function TelegramStatusLine({ status }: { status: Overview['telegram'] }) {
  if (!status) return null;
  if (status.state === 'running') {
    return (
      <div className="alert alert-ok">
        Telegram bot is live as{' '}
        <a href={`https://t.me/${status.username}`} target="_blank" rel="noreferrer">
          @{status.username}
        </a>{' '}
        ({status.mode}). Telegram enquiries appear below with a Telegram badge.
      </div>
    );
  }
  if (status.state === 'starting') return <div className="alert alert-info">Telegram bot is starting…</div>;
  if (status.state === 'waiting_for_lease') {
    return <div className="alert alert-info">Telegram bot @{status.username} is being polled by another process; this server is on standby.</div>;
  }
  return <div className={`alert ${status.state === 'error' ? 'alert-error' : 'alert-info'}`}>Telegram bot off: {status.reason}</div>;
}

export function OverviewPage() {
  const call = useAdminApi();
  const navigate = useNavigate();
  const [data, setData] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<LeadListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, l] = await Promise.all([
        call<Overview>('/api/admin/overview'),
        call<{ items: LeadListItem[] }>('/api/admin/leads?page_size=5'),
      ]);
      setData(o);
      setRecent(l.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load overview');
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
      </div>
      <ErrorAlert error={error} onRetry={() => void load()} />
      {!data && !error && <Spinner />}
      {data && (
        <>
          <TelegramStatusLine status={data.telegram} />
          {data.demo_properties > 0 && (
            <div className="alert alert-info">
              {data.demo_properties} active listing{data.demo_properties === 1 ? ' is' : 's are'} sample demo data (codes CP-DEMO-###). Replace them with
              approved inventory before any real launch.
            </div>
          )}
          <div className="stats">
            <Link to="/admin/properties" className="panel stat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="value">{data.active_properties}</div>
              <div className="label">Active properties</div>
            </Link>
            <Link to="/admin/leads?status=new" className="panel stat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="value">{data.new_leads}</div>
              <div className="label">New leads</div>
            </Link>
            <Link to="/admin/leads?status=visit_requested" className="panel stat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="value">{data.visit_requests}</div>
              <div className="label">Visit requests (unconfirmed)</div>
            </Link>
            <Link to="/admin/leads" className="panel stat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="value">{data.total_leads}</div>
              <div className="label">All leads</div>
            </Link>
          </div>
          <h2>Latest leads</h2>
          {recent.length === 0 ? (
            <div className="panel">
              <EmptyState title="No leads yet">
                <p>Enquiries from the customer chat will appear here.</p>
              </EmptyState>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Customer</th>
                    <th>Channel</th>
                    <th>Type</th>
                    <th>Listing</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((l) => (
                    <tr key={l.id} className="clickable" onClick={() => navigate(`/admin/leads/${l.id}`)}>
                      <td>
                        <Link to={`/admin/leads/${l.id}`}>{formatDateTime(l.created_at)}</Link>
                      </td>
                      <td>{l.customer_name ?? <span className="subtle">No name yet</span>}</td>
                      <td>
                        <ChannelBadge channel={l.channel} />
                      </td>
                      <td>{humanise(l.enquiry_type)}</td>
                      <td className="mono">{l.listing_code ?? '—'}</td>
                      <td>
                        <StatusBadge status={l.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
