import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DemoBadge, Dialog, EmptyState, ErrorAlert, Field, Spinner, StatusBadge } from '../components/ui';
import { ApiError, humanise } from '../lib/api';
import type { AdminProperty } from '../lib/types';
import { useAdmin, useAdminApi } from './AdminApp';
import { formatPriceLabel } from './format';

interface ListResponse {
  items: AdminProperty[];
  total: number;
  page: number;
  page_size: number;
}

const PAGE_SIZE = 20;

export function PropertiesPage() {
  const call = useAdminApi();
  const { meta } = useAdmin();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [confirm, setConfirm] = useState<AdminProperty | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const page = Number(params.get('page') ?? '1') || 1;
  const query = params.toString();

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams(query);
      qs.set('page_size', String(PAGE_SIZE));
      setData(await call<ListResponse>(`/api/admin/properties?${qs}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load properties');
    }
  }, [call, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  };

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setFilter('search', search.trim());
  }

  async function deactivate(p: AdminProperty) {
    try {
      await call(`/api/admin/properties/${p.id}/deactivate`, { body: {} });
      setNotice(`${p.listing_code} deactivated. It no longer appears in customer search.`);
      setConfirm(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not deactivate');
      setConfirm(null);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="page-head">
        <h1 className="spacer">Properties</h1>
        <button className="btn" onClick={() => setImporting(true)}>
          Import CSV
        </button>
        <Link to="/admin/properties/new" className="btn btn-primary">
          Add listing
        </Link>
      </div>

      <form className="filters" onSubmit={onSearch} role="search">
        <Field label="Search code or title">
          {(p) => <input {...p} className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="CP-DEMO-001" />}
        </Field>
        <Field label="Status">
          {(p) => (
            <select {...p} className="input" value={params.get('status') ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any</option>
              {meta.enums.availability_status.map((s) => (
                <option key={s} value={s}>
                  {humanise(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Type">
          {(p) => (
            <select {...p} className="input" value={params.get('transaction_type') ?? ''} onChange={(e) => setFilter('transaction_type', e.target.value)}>
              <option value="">Rent &amp; sale</option>
              <option value="rent">Rent</option>
              <option value="sale">Sale</option>
            </select>
          )}
        </Field>
        <Field label="Locality">
          {(p) => (
            <select {...p} className="input" value={params.get('locality') ?? ''} onChange={(e) => setFilter('locality', e.target.value)}>
              <option value="">Any</option>
              {meta.localities.map((l) => (
                <option key={l.name}>{l.name}</option>
              ))}
            </select>
          )}
        </Field>
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      {notice && (
        <div className="alert alert-ok row" role="status">
          <span className="spacer">{notice}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      <ErrorAlert error={error} onRetry={() => void load()} />
      {!data && !error && <Spinner />}

      {data &&
        (data.items.length === 0 ? (
          <div className="panel">
            <EmptyState title="No listings match these filters">
              <p>Try clearing a filter, or add a new listing.</p>
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Listing</th>
                    <th>Locality</th>
                    <th>Price</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.listing_code}</td>
                      <td>
                        <div>{p.title}</div>
                        <div className="row" style={{ marginTop: 2 }}>
                          <span className="subtle">
                            {p.transaction_type === 'rent' ? 'Rent' : 'Sale'} · {p.bedrooms !== null ? `${p.bedrooms}BHK · ` : ''}
                            {humanise(p.property_type)}
                          </span>
                          {p.is_demo && <DemoBadge />}
                        </div>
                      </td>
                      <td>{p.locality}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatPriceLabel(p.price_amount, p.price_period)}</td>
                      <td>
                        <StatusBadge status={p.availability_status} />
                      </td>
                      <td className="subtle">{new Date(p.updated_at).toLocaleDateString('en-IN')}</td>
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          {p.availability_status !== 'deactivated' && (
                            <>
                              <Link className="btn btn-sm" to={`/admin/properties/${p.id}`}>
                                Edit
                              </Link>
                              <button className="btn btn-sm btn-danger" onClick={() => setConfirm(p)}>
                                Deactivate
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span className="muted">
                {data.total} listing{data.total === 1 ? '' : 's'} · page {page} of {totalPages}
              </span>
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setParams((prev) => { const n = new URLSearchParams(prev); n.set('page', String(page - 1)); return n; })}>
                Previous
              </button>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setParams((prev) => { const n = new URLSearchParams(prev); n.set('page', String(page + 1)); return n; })}>
                Next
              </button>
            </div>
          </>
        ))}

      {confirm && (
        <Dialog title={`Deactivate ${confirm.listing_code}?`} onClose={() => setConfirm(null)}>
          <p>
            “{confirm.title}” will be removed from customer search immediately. Existing leads keep their link to it. This cannot be undone from
            the dashboard.
          </p>
          <div className="row">
            <span className="spacer" />
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={() => void deactivate(confirm)}>
              Deactivate listing
            </button>
          </div>
        </Dialog>
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(n) => {
            setImporting(false);
            setNotice(`Imported ${n} listing${n === 1 ? '' : 's'}.`);
            void load();
          }}
        />
      )}
    </>
  );
}

interface ImportReport {
  dryRun: boolean;
  totalRows: number;
  valid: number;
  imported: number;
  errors: { row: number; listing_code?: string; errors: string[] }[];
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (n: number) => void }) {
  const call = useAdminApi();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ report: ImportReport }>('/api/admin/properties/import', { body: { csv, dry_run: dryRun } });
      if (!dryRun && res.report.imported > 0) onImported(res.report.imported);
      else setReport(res.report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Import listings from CSV" onClose={onClose}>
      <p className="muted">
        Required columns: <span className="mono">listing_code, title, transaction_type, property_type, locality, price_amount, price_period</span>. Optional:
        bedrooms, bathrooms, area_sqft, furnishing, amenities (separate with |), parking, pet_policy, availability_status, address_public,
        description, image_urls (|-separated). If any row is invalid, nothing is imported.
      </p>
      <Field label="CSV file" hint={fileName || 'Choose a .csv file'}>
        {(p) => (
          <input
            {...p}
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              setCsv(await f.text());
              setReport(null);
            }}
          />
        )}
      </Field>
      <ErrorAlert error={error} />
      {report && (
        <div className="stack" style={{ gap: 8 }}>
          <div className={`alert ${report.errors.length ? 'alert-error' : 'alert-ok'}`} role="status">
            {report.totalRows} row(s) checked · {report.valid} valid · {report.errors.length} with errors
          </div>
          {report.errors.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Code</th>
                    <th>Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {report.errors.map((e) => (
                    <tr key={e.row}>
                      <td>{e.row || '—'}</td>
                      <td className="mono">{e.listing_code ?? ''}</td>
                      <td>{e.errors.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="row">
        <span className="spacer" />
        <button className="btn" disabled={!csv || busy} onClick={() => void run(true)}>
          {busy ? 'Checking…' : 'Validate'}
        </button>
        <button className="btn btn-primary" disabled={!report || report.errors.length > 0 || report.valid === 0 || busy} onClick={() => void run(false)}>
          Import {report?.valid ? report.valid : ''} listing{report?.valid === 1 ? '' : 's'}
        </button>
      </div>
    </Dialog>
  );
}
