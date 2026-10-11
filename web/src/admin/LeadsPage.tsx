import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorAlert, Field, Spinner, StatusBadge } from '../components/ui';
import { ApiError, formatDateTime, humanise } from '../lib/api';
import type { LeadListItem } from '../lib/types';
import { useAdmin, useAdminApi } from './AdminApp';

const PAGE_SIZE = 20;

export function LeadsPage() {
  const call = useAdminApi();
  const { meta } = useAdmin();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ items: LeadListItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? '1') || 1;

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (status) qs.set('status', status);
      setData(await call(`/api/admin/leads?${qs}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load leads');
    }
  }, [call, page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const go = (p: number) => {
    const n = new URLSearchParams(params);
    n.set('page', String(p));
    setParams(n);
  };

  return (
    <>
      <div className="page-head">
        <h1 className="spacer">Leads</h1>
        <div className="filters">
          <Field label="Status">
            {(p) => (
              <select
                {...p}
                className="input"
                value={status}
                onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}
              >
                <option value="">All statuses</option>
                {meta.enums.lead_status.map((s) => (
                  <option key={s} value={s}>
                    {humanise(s)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </div>
      <ErrorAlert error={error} onRetry={() => void load()} />
      {!data && !error && <Spinner />}
      {data &&
        (data.items.length === 0 ? (
          <div className="panel">
            <EmptyState title={status ? `No ${humanise(status)} leads` : 'No leads yet'}>
              <p>Callback and site-visit requests from the chat will appear here.</p>
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Customer</th>
                    <th>Request</th>
                    <th>Listing</th>
                    <th>Assigned</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((l) => (
                    <tr key={l.id} className="clickable" onClick={() => navigate(`/admin/leads/${l.id}`)}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Link to={`/admin/leads/${l.id}`} onClick={(e) => e.stopPropagation()}>
                          {formatDateTime(l.created_at)}
                        </Link>
                      </td>
                      <td>
                        {l.customer_name ?? <span className="subtle">No name yet</span>}
                        <div className="subtle">{l.customer_phone ?? 'No phone shared'}</div>
                      </td>
                      <td>
                        {humanise(l.enquiry_type)}
                        {l.preferred_time_text && <div className="subtle">Wants: {l.preferred_time_text}</div>}
                      </td>
                      <td>
                        {l.listing_code ? <span className="mono">{l.listing_code}</span> : <span className="subtle">General</span>}
                        {l.property_title && <div className="subtle">{l.property_title}</div>}
                      </td>
                      <td>{l.assigned_agent ?? <span className="subtle">—</span>}</td>
                      <td>
                        <StatusBadge status={l.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span className="muted">
                {data.total} lead{data.total === 1 ? '' : 's'} · page {page} of {totalPages}
              </span>
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => go(page - 1)}>
                Previous
              </button>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => go(page + 1)}>
                Next
              </button>
            </div>
          </>
        ))}
    </>
  );
}
