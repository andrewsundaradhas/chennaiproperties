import { useState } from 'react';
import { humanise } from '../lib/api';
import type { PropertyCardItem } from '../lib/types';
import { DemoBadge, StatusBadge } from './ui';

export interface CardActions {
  onAsk: (message: string) => void;
  disabled?: boolean;
}

function Media({ item }: { item: PropertyCardItem }) {
  const [failed, setFailed] = useState(false);
  const img = item.images[0];
  return (
    <div className="pcard-media">
      {img && !failed ? (
        <img src={img.image_url} alt={img.alt_text ?? item.title} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="placeholder" aria-label="No photo available">
          <span aria-hidden="true">🏠</span>
          <span>No photo yet</span>
        </div>
      )}
      {item.index > 0 && (
        <span className="pcard-index" aria-label={`Result ${item.index}`}>
          {item.index}
        </span>
      )}
    </div>
  );
}

export function PropertyCard({ item, actions, wide = false }: { item: PropertyCardItem; actions?: CardActions; wide?: boolean }) {
  const facts = [
    item.bedrooms !== null ? `${item.bedrooms}BHK` : null,
    humanise(item.property_type),
    item.area_sqft ? `${item.area_sqft.toLocaleString('en-IN')} sq.ft` : null,
    item.furnishing !== 'unknown' ? humanise(item.furnishing) : null,
  ].filter(Boolean);
  const ask = (m: string) => actions?.onAsk(m);
  return (
    <article className={`pcard${wide ? ' pcard-wide' : ''}`} aria-label={`${item.listing_code}: ${item.title}`}>
      <Media item={item} />
      <div className="stack" style={{ gap: 0, flex: 1 }}>
        <div className="pcard-body">
          <div className="row">
            <span className="mono muted">{item.listing_code}</span>
            <span className="spacer" />
            <StatusBadge status={item.availability_status} />
          </div>
          <div className="pcard-price">
            {item.price_label}
            {item.transaction_type === 'rent' ? '' : <span className="subtle"> · for sale</span>}
          </div>
          <div className="pcard-title">{item.title}</div>
          <div className="pcard-facts">
            {item.locality} · {facts.join(' · ')}
          </div>
          {item.reasons.length > 0 && (
            <ul className="reasons" aria-label="Why it matches">
              {item.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {item.caveats.length > 0 && (
            <ul className="caveats" aria-label="Please note">
              {item.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          {wide && item.description && <p className="pcard-facts">{item.description}</p>}
          <div className="row">
            {item.is_demo && <DemoBadge />}
            <span className="subtle">Updated {new Date(item.updated_at).toLocaleDateString('en-IN')}</span>
          </div>
        </div>
        {actions && (
          <div className="pcard-actions">
            {!wide && (
              <button className="btn btn-sm" disabled={actions.disabled} onClick={() => ask(`Tell me more about ${item.listing_code}`)}>
                Details
              </button>
            )}
            <button className="btn btn-sm" disabled={actions.disabled} onClick={() => ask(`Please call me back about ${item.listing_code}`)}>
              Callback
            </button>
            <button className="btn btn-sm" disabled={actions.disabled} onClick={() => ask(`I'd like a site visit for ${item.listing_code}`)}>
              Visit
            </button>
            <button className="btn btn-sm" disabled={actions.disabled} onClick={() => ask(`Shortlist ${item.listing_code}`)}>
              Save
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
