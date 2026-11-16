// Maps Virgin's programme genre labels (e.g. "Film", "Western", "Sitcom",
// "Sports Show", "Cricket", "Natural World") to the genre ids the Alexa
// skill understands. The ids match GENRE slot ids in the interaction model.

const RULES = [
  // id            matches any Virgin genre label containing one of these (lower case)
  ['film',         ['film', 'movie']],
  ['western',      ['western']],
  ['thriller',     ['thriller', 'suspense']],
  ['horror',       ['horror']],
  ['scifi',        ['science fiction', 'sci-fi', 'fantasy']],
  ['action',       ['action', 'adventure']],
  ['romance',      ['romance', 'romantic']],
  ['comedy',       ['comedy', 'sitcom', 'sketch', 'stand-up', 'standup']],
  ['drama',        ['drama', 'soap']],
  ['soap',         ['soap']],
  ['news',         ['news', 'public affairs', 'politics', 'weather', 'current affairs']],
  ['sport',        ['sport']],
  ['football',     ['football', 'soccer']],
  ['rugby',        ['rugby']],
  ['cricket',      ['cricket']],
  ['snooker',      ['snooker', 'billiards', 'pool']],
  ['darts',        ['darts']],
  ['golf',         ['golf']],
  ['tennis',       ['tennis']],
  ['racing',       ['horse', 'equestrian']],
  ['motorsport',   ['motorsport', 'auto racing', 'motor racing', 'formula', 'motorcycle', 'nascar', 'rally']],
  ['boxing',       ['boxing', 'martial arts', 'wrestling', 'mma']],
  ['quiz',         ['gameshow', 'game show', 'quiz']],
  ['documentary',  ['documentary', 'docudrama', 'biography', 'docuseries']],
  ['history',      ['history', 'historical']],
  ['nature',       ['natural world', 'nature', 'animals', 'wildlife', 'environment', 'pets', 'outdoors']],
  ['science',      ['science', 'technology', 'space', 'aviation', 'engineering']],
  ['cooking',      ['cookery', 'cooking', 'food', 'baking']],
  ['travel',       ['travel']],
  ['music',        ['music', 'concert', 'musical', 'opera', 'dance']],
  ['antiques',     ['collectibles', 'collectables', 'antiques', 'auction']],
  ['property',     ['home & garden', 'home improvement', 'house', 'property', 'diy']],
  ['gardening',    ['garden']],
  ['entertainment',['talk', 'chat show', 'interview', 'entertainment', 'variety', 'fundraiser', 'awards']],
  ['reality',      ['reality']],
  ['kids',         ['children', 'kids']],
  ['religion',     ['religio', 'faith', 'spiritual']],
  ['motoring',     ['auto', 'motoring', 'cars', 'motors']],
];

// Channel-level genres from Virgin's channel list, used when a programme has none.
const CHANNEL_FALLBACK = {
  movies: ['film'], sports: ['sport'], news: ['news'], kids: ['kids'], music: ['music'], documentaries: ['documentary'],
};

export function genreIdsFor(labels, channelGenre, year, title) {
  const lower = (labels || []).map((l) => String(l).toLowerCase());
  const ids = new Set();
  for (const [id, keys] of RULES) {
    if (lower.some((l) => keys.some((k) => l.includes(k)))) ids.add(id);
  }
  if (ids.size === 0) {
    const cg = String(channelGenre || '').toLowerCase();
    for (const [k, v] of Object.entries(CHANNEL_FALLBACK)) if (cg.includes(k)) v.forEach((x) => ids.add(x));
  }
  if (/^\s*(live:|live\b)/i.test(title || '') && ids.has('sport')) ids.add('livesport');

  const crime = lower.some((l) => /crime|mystery|detective|police|legal|whodunit/.test(l));
  const factual = ids.has('documentary') || ids.has('reality') || lower.some((l) => /investigat|true crime/.test(l));
  // A bare "Crime" label (no drama/mystery/film/comedy alongside) is usually a true-crime documentary.
  const fiction = ids.has('drama') || ids.has('film') || ids.has('comedy') || lower.some((l) => /mystery|detective|police|legal/.test(l));
  if (crime && fiction && !factual) { ids.add('crimedrama'); ids.add('drama'); }
  else if (crime) ids.add('truecrime');

  // Motoring rule must not fire on motorsport-only labels like "Auto Racing".
  if (ids.has('motorsport') && !lower.some((l) => /motoring|\bcars\b|motors\b/.test(l))) ids.delete('motoring');

  const y = Number(String(year || '').slice(0, 4));
  if (ids.has('film')) {
    if (y && y < 1970) ids.add('classicfilm');
    if (lower.some((l) => /\bwar\b/.test(l))) ids.add('warfilm');
  }
  // "Sports Show" is a label on programmes about sport too; that's fine — still sport.
  return [...ids];
}
