// Builds out/listings.json from Virgin TV Go's public guide.
// Runs on GitHub Actions every few hours (see .github/workflows/build-listings.yml).
// Node 20+, no dependencies.  Run locally with:  node builder/build.mjs
//
// Output is read by the Alexa skill (lambda/listings.js).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { genreIdsFor } from './genres.mjs';

const OUT_DIR = process.env.OUT_DIR || 'out';
const HOURS_AHEAD = 54;      // covers "tomorrow night" from any time today
const CONCURRENCY = 6;       // be polite to Virgin's servers
const MAX_DETAIL_CALLS = 9000;

const UA = 'Mozilla/5.0 (personal telly-guide Alexa skill; non-commercial)';
const CHANNELS_URL = 'https://spark-prod-gb.gnp.cloud.virgintvgo.virginmedia.com/eng/web/linear-service/v2/channels?cityId=40980&language=en&productClass=Orion-DASH&platform=web';
const SEGMENT_URL = (stamp) => `https://staticqbr-prod-gb.gnp.cloud.virgintvgo.virginmedia.com/eng/web/epg-service-lite/gb/en/events/segments/${stamp}`;
const DETAIL_URL = (id) => `https://spark-prod-gb.gnp.cloud.virgintvgo.virginmedia.com/eng/web/linear-service/v2/replayEvent/${encodeURIComponent(id)}?returnLinearContent=true&forceLinearResponse=true&language=en`;

// Virgin channel-number ranges worth reading out. Shopping, international,
// music-video, +1 and UHD duplicates are left out.
const KEEP_RANGES = [[101, 199], [401, 445], [501, 551], [601, 626], [701, 730]];
const DROP_NAME = /\+ ?1\b|UHD|Ultra HD|^Store$|Highlights/i;

// Names as they should be spoken. Anything not listed is tidied automatically.
const SPOKEN_OVERRIDES = {
  'BBC ONE London HD': 'BBC One', 'BBC TWO HD': 'BBC Two', 'BBC THREE HD': 'BBC Three', 'BBC FOUR HD': 'BBC Four',
  'ITV1 HD': 'ITV', 'Channel 4HD': 'Channel 4', 'Channel 5 HD': 'Channel 5', '4SevenHD': '4seven',
  'U&GOLD HD': 'Gold', 'U&Alibi HD': 'Alibi', 'U&Dave HD': 'Dave', 'U&Drama HD': 'Drama', 'U&W HD': 'W',
  'U&Yesterday HD': 'Yesterday', 'U&Eden HD': 'Eden', '5STAR': '5 Star', '5 USA': '5 USA', '5Action': '5 Action',
  '5Drama': '5 Drama', 'Crime+Inv HD': 'Crime and Investigation', 'I.D.': 'Investigation Discovery',
  'TRUE CRIME': 'True Crime', 'TRUE CRIME XTRA': 'True Crime Extra', 'LEGEND': 'Legend', 'LEGEND XTRA': 'Legend Extra',
  'More 4 HD': 'More4', 'Film4 HD': 'Film4', 'GREAT! tv': 'Great TV', 'GREAT! mystery': 'Great Mystery',
  'GREAT! action': 'Great Action', 'GREAT! Christmas': 'Great Christmas', 'Sky HISTORY HD': 'Sky History',
  'Sky SportsMainEventHD': 'Sky Sports Main Event', 'Sky Sports PL HD': 'Sky Sports Premier League',
  'Sky Sports FootballHD': 'Sky Sports Football', 'Sky Sports + HD': 'Sky Sports Plus',
  'Sky SciFi & Hor HD': 'Sky Cinema Sci-Fi and Horror', 'Sky Premiere HD': 'Sky Cinema Premiere',
  'Sky Select': 'Sky Cinema Select', 'Sky Hits': 'Sky Cinema Hits', 'Sky Greats HD': 'Sky Cinema Greats',
  'Sky Family HD': 'Sky Cinema Family', 'Sky Action': 'Sky Cinema Action', 'Sky Thriller HD': 'Sky Cinema Thriller',
  'Sky Drama HD': 'Sky Cinema Drama', 'MUTV': 'M U T V', 'BBC NEWS HD': 'BBC News', 'CBBC HD': 'CBBC',
  'CBeebies HD': 'CBeebies', 'MTV HD': 'MTV', 'TLC HD': 'TLC', 'Nat Geo WILD HD': 'Nat Geo Wild',
  'National GeographicHD': 'National Geographic', 'euronews': 'Euronews', 'Nick HD': 'Nickelodeon',
};
// Virgin lists Sky Comedy twice (112 and 408); 408 is the Sky Cinema one.
const SPOKEN_BY_NUMBER = { 408: 'Sky Cinema Comedy' };

// Virgin's top-level product codes → the package tiers the skill lets him pick.
// Channels with none of these are separate add-ons (Premier Sports, Racing TV, MUTV…).
const PACK_CODES = {
  40000010: 'basic', 40000020: 'entertainment', 40000030: 'skycinema',
  40000040: 'skysports', 40000050: 'tnt', 40000060: 'kids',
};
function packsOf(products) {
  const packs = [...new Set((products || []).map((p) => PACK_CODES[p]).filter(Boolean))];
  return packs.length ? packs : ['extra'];
}

function spokenName(name, number) {
  if (SPOKEN_BY_NUMBER[number]) return SPOKEN_BY_NUMBER[number];
  if (SPOKEN_OVERRIDES[name]) return SPOKEN_OVERRIDES[name];
  let s = name.replace(/\s*HD$/i, '').replace(/^U&/, '').replace(/&/g, ' and ').trim();
  if (s === s.toUpperCase() && s.length > 4) s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

function segmentStamps(fromMs, toMs) {
  const six = 6 * 3600 * 1000;
  const stamps = [];
  for (let t = Math.floor(fromMs / six) * six; t < toMs; t += six) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    stamps.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}0000`);
  }
  return stamps;
}

async function loadCache(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
}

async function main() {
  const started = Date.now();
  const nowS = Math.floor(started / 1000);
  const untilS = nowS + HOURS_AHEAD * 3600;

  // 1. Channels
  const rawChannels = await getJson(CHANNELS_URL);
  const channels = rawChannels
    .filter((c) => !c.isHidden && !c.isPPV)
    .map((c) => ({
      id: String(c.id), number: Number(c.logicalChannelNumber), name: c.name, genre: (c.genre || []).join(', '),
      packs: packsOf(c.linearProducts),
    }))
    .filter((c) => KEEP_RANGES.some(([a, b]) => c.number >= a && c.number <= b) && !DROP_NAME.test(c.name))
    .sort((a, b) => a.number - b.number);
  // Some channels appear at two numbers (e.g. regional BBC One); keep the lowest.
  const seenIds = new Set();
  const keptChannels = channels.filter((c) => (seenIds.has(c.id) ? false : seenIds.add(c.id)));
  keptChannels.forEach((c) => { c.spoken = spokenName(c.name, c.number); });
  const channelIndex = new Map(keptChannels.map((c, i) => [c.id, i]));
  console.log(`channels kept: ${keptChannels.length}`);

  // 2. Schedule segments (6 hours each, all channels)
  const events = new Map();
  for (const stamp of segmentStamps(started - 6 * 3600e3, untilS * 1000)) {
    const seg = await getJson(SEGMENT_URL(stamp));
    if (!seg || !Array.isArray(seg.entries)) { console.log(`segment ${stamp}: none`); continue; }
    for (const entry of seg.entries) {
      if (!channelIndex.has(String(entry.channelId))) continue;
      for (const ev of entry.events || []) {
        if (ev.endTime <= nowS - 1800 || ev.startTime >= untilS) continue;
        events.set(`${entry.channelId}|${ev.startTime}`, { ch: String(entry.channelId), ev });
      }
    }
    console.log(`segment ${stamp}: ok`);
  }
  console.log(`events in window: ${events.size}`);

  // 3. Details (genres, description, year) — cached between runs by programme id
  const cachePath = `${OUT_DIR}/details-cache.json`;
  const cache = await loadCache(cachePath);
  const keyOf = (ev) => ev.mergedId || ev.id;
  const todo = [...new Map([...events.values()].filter(({ ev }) => !cache[keyOf(ev)]).map(({ ev }) => [keyOf(ev), ev])).values()]
    .slice(0, MAX_DETAIL_CALLS);
  console.log(`detail lookups needed: ${todo.length}`);
  let done = 0, failed = 0;
  await pool(todo, CONCURRENCY, async (ev) => {
    try {
      const d = await getJson(DETAIL_URL(ev.id), 2);
      cache[keyOf(ev)] = d
        ? { g: d.genres || [], d: d.shortDescription || d.longDescription || '', y: d.productionDate || '', ep: d.episodeName || '', seen: nowS }
        : { g: [], d: '', y: '', ep: '', seen: nowS };
    } catch { failed++; }
    if (++done % 500 === 0) console.log(`  details ${done}/${todo.length}`);
  });
  console.log(`detail lookups failed: ${failed}`);

  // 4. Assemble compact output
  const out = [];
  for (const { ch, ev } of events.values()) {
    const det = cache[keyOf(ev)] || { g: [], d: '', y: '', ep: '' };
    det.seen = nowS;
    const channel = keptChannels[channelIndex.get(ch)];
    out.push({
      c: channelIndex.get(ch),
      s: ev.startTime,
      e: ev.endTime,
      t: ev.title,
      ep: det.ep || ev.seriesName || '',
      g: genreIdsFor(det.g, channel.genre, det.y, ev.title),
      vg: det.g.join(', '),
      y: det.y ? Number(String(det.y).slice(0, 4)) || 0 : 0,
      d: det.d,
    });
  }
  out.sort((a, b) => a.s - b.s || keptChannels[a.c].number - keptChannels[b.c].number);

  // Drop cache entries not seen for a week so the file doesn't grow forever.
  for (const k of Object.keys(cache)) if (nowS - (cache[k].seen || 0) > 7 * 86400) delete cache[k];

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/listings.json`, JSON.stringify({
    generatedAt: new Date(started).toISOString(),
    source: 'Virgin TV Go public guide',
    channels: keptChannels.map(({ id, number, name, spoken, genre, packs }) => ({ id, number, name, spoken, genre, packs })),
    events: out,
  }));
  await writeFile(cachePath, JSON.stringify(cache));
  console.log(`wrote ${out.length} events in ${Math.round((Date.now() - started) / 1000)}s`);
  if (out.length < 500) { console.error('Too few events — something is wrong with the source.'); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
