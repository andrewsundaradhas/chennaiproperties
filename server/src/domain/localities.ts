// Controlled locality vocabulary. Search matches against these canonical names, never free text.
// Corridors (OMR, ECR, GST) group localities but are NOT treated as one place: an exact
// locality match always ranks above a corridor match.

export interface LocalityDef {
  name: string;
  aliases: string[];
  corridor?: Corridor;
}

export type Corridor = 'OMR' | 'ECR' | 'GST Road' | 'Central' | 'West' | 'North' | 'South';

export const LOCALITIES: LocalityDef[] = [
  { name: 'Velachery', aliases: ['velachery', 'velacheri', 'vellachery'], corridor: 'South' },
  { name: 'Adyar', aliases: ['adyar', 'adayar'], corridor: 'South' },
  { name: 'Besant Nagar', aliases: ['besant nagar', 'besantnagar', 'bessie'], corridor: 'South' },
  { name: 'Thiruvanmiyur', aliases: ['thiruvanmiyur', 'tiruvanmiyur'], corridor: 'South' },
  { name: 'Mylapore', aliases: ['mylapore', 'mylai'], corridor: 'Central' },
  { name: 'T. Nagar', aliases: ['t nagar', 't. nagar', 'tnagar', 'thyagaraya nagar'], corridor: 'Central' },
  { name: 'Nungambakkam', aliases: ['nungambakkam', 'nungambakam'], corridor: 'Central' },
  { name: 'Alwarpet', aliases: ['alwarpet'], corridor: 'Central' },
  { name: 'Anna Nagar', aliases: ['anna nagar', 'annanagar'], corridor: 'West' },
  { name: 'Kilpauk', aliases: ['kilpauk', 'kilpak'], corridor: 'Central' },
  { name: 'Ashok Nagar', aliases: ['ashok nagar', 'ashoknagar'], corridor: 'West' },
  { name: 'K.K. Nagar', aliases: ['kk nagar', 'k.k. nagar', 'k k nagar', 'kknagar'], corridor: 'West' },
  { name: 'Porur', aliases: ['porur'], corridor: 'West' },
  { name: 'Valasaravakkam', aliases: ['valasaravakkam', 'valasarvakkam'], corridor: 'West' },
  { name: 'Guindy', aliases: ['guindy'], corridor: 'South' },
  { name: 'Perungudi', aliases: ['perungudi'], corridor: 'OMR' },
  { name: 'Thoraipakkam', aliases: ['thoraipakkam', 'thoraipakam'], corridor: 'OMR' },
  { name: 'Sholinganallur', aliases: ['sholinganallur', 'sholinganalur', 'shollinganallur'], corridor: 'OMR' },
  { name: 'Navalur', aliases: ['navalur'], corridor: 'OMR' },
  { name: 'Siruseri', aliases: ['siruseri'], corridor: 'OMR' },
  { name: 'Kelambakkam', aliases: ['kelambakkam', 'kelambakam'], corridor: 'OMR' },
  { name: 'Neelankarai', aliases: ['neelankarai'], corridor: 'ECR' },
  { name: 'Injambakkam', aliases: ['injambakkam'], corridor: 'ECR' },
  { name: 'Pallikaranai', aliases: ['pallikaranai'], corridor: 'South' },
  { name: 'Medavakkam', aliases: ['medavakkam', 'medavakam'], corridor: 'South' },
  { name: 'Tambaram', aliases: ['tambaram', 'thambaram'], corridor: 'GST Road' },
  { name: 'Chromepet', aliases: ['chromepet', 'chrompet'], corridor: 'GST Road' },
  { name: 'Perambur', aliases: ['perambur'], corridor: 'North' },
];

const CORRIDOR_ALIASES: Record<string, Corridor> = {
  omr: 'OMR',
  'old mahabalipuram road': 'OMR',
  'it corridor': 'OMR',
  'rajiv gandhi salai': 'OMR',
  ecr: 'ECR',
  'east coast road': 'ECR',
  'gst road': 'GST Road',
  gst: 'GST Road',
};

export interface ResolvedLocation {
  /** Canonical locality names that matched the term exactly. */
  localities: string[];
  /** Corridors requested (e.g. "OMR") — these match every locality in the corridor. */
  corridors: Corridor[];
  /** Terms we could not resolve; reported back instead of guessed. */
  unknown: string[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function resolveLocalityTerm(term: string): { locality?: string; corridor?: Corridor } {
  const t = norm(term);
  const corridor = CORRIDOR_ALIASES[t];
  if (corridor) return { corridor };
  const loc = LOCALITIES.find(
    (l) => norm(l.name) === t || l.aliases.some((a) => norm(a) === t || norm(a).replace(/\./g, '') === t.replace(/\./g, '')),
  );
  return loc ? { locality: loc.name } : {};
}

export function resolveLocalityTerms(terms: string[]): ResolvedLocation {
  const out: ResolvedLocation = { localities: [], corridors: [], unknown: [] };
  for (const term of terms) {
    const r = resolveLocalityTerm(term);
    if (r.locality && !out.localities.includes(r.locality)) out.localities.push(r.locality);
    else if (r.corridor && !out.corridors.includes(r.corridor)) out.corridors.push(r.corridor);
    else if (!r.locality && !r.corridor) out.unknown.push(term);
  }
  return out;
}

export function localitiesInCorridor(corridor: Corridor): string[] {
  return LOCALITIES.filter((l) => l.corridor === corridor).map((l) => l.name);
}

export function corridorOf(locality: string): Corridor | undefined {
  return LOCALITIES.find((l) => l.name === locality)?.corridor;
}

export function isKnownLocality(name: string): boolean {
  return LOCALITIES.some((l) => l.name === name);
}

/** Finds locality / corridor mentions inside free text (used by the rule-based interpreter). */
export function findLocalityMentions(text: string): string[] {
  const t = ` ${norm(text)} `;
  const found: string[] = [];
  for (const [alias, corridor] of Object.entries(CORRIDOR_ALIASES)) {
    if (t.includes(` ${alias} `) && !found.includes(corridor)) found.push(corridor);
  }
  for (const l of LOCALITIES) {
    const hit = [l.name, ...l.aliases].some((a) => t.includes(` ${norm(a)} `));
    if (hit && !found.includes(l.name)) found.push(l.name);
  }
  return found;
}
