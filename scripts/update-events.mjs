#!/usr/bin/env node
/**
 * update-events.mjs — zero-dependency event updater.
 *
 * 1. Reads data/sources.json (iCal feeds) and data/manual-events.json (curated).
 * 2. Fetches each enabled feed, parses VEVENTs, normalizes to the site schema.
 * 3. Validates, dedupes (feed events override manual ones with the same URL),
 *    drops past events, sorts, and writes events.json for the site to fetch.
 *
 * Runs on Node 18+ (built-in fetch). No packages, no API keys, no cost.
 *   node scripts/update-events.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "events.json");

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/* ---------------- iCal parsing ---------------- */

/** Unfold RFC 5545 folded lines (continuation lines start with space/tab). */
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeICS(v) {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** Parse DTSTART/DTEND values: 20261020, 20261020T180000Z, 20261020T180000 (+TZID). */
function parseICSDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Date-only comparison is all the site needs; keep it as a local calendar date.
  return { y: +y, mo: +mo, d: +d, iso: `${y}-${mo}-${d}` };
}

/** Very small VEVENT extractor — enough for Luma and Meetup feeds. */
function parseICS(text) {
  const events = [];
  const blocks = unfold(text).split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const get = (prop) => {
      const re = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, "m");
      const m = body.match(re);
      return m ? unescapeICS(m[1]) : "";
    };
    const start = parseICSDate((body.match(/^DTSTART(?:;[^:]*)?:(\S+)/m) || [])[1] || "");
    const end = parseICSDate((body.match(/^DTEND(?:;[^:]*)?:(\S+)/m) || [])[1] || "");
    if (!start) continue;
    events.push({
      start,
      end,
      summary: get("SUMMARY"),
      location: get("LOCATION"),
      description: get("DESCRIPTION"),
      url: get("URL") || extractFirstUrl(get("DESCRIPTION")),
    });
  }
  return events;
}

function extractFirstUrl(text) {
  const m = (text || "").match(/https?:\/\/[^\s"'<>)\]]+/);
  return m ? m[0] : "";
}

/* ---------------- normalization ---------------- */

function classify(title, fallback) {
  const t = title.toLowerCase();
  if (/hackathon|hack\s*day|build[- ]?a[- ]?thon|buildathon/.test(t)) return "hackathon";
  if (/summit|conference|congress|forum|expo|devday|gtc\b/.test(t)) return "conference";
  if (/meetup|demo night|workshop|talks?\b|office hours|ama\b/.test(t)) return "meetup";
  return fallback || "meetup";
}

function dateLabel(start, end) {
  const s = `${MONTHS_SHORT[start.mo - 1]} ${start.d}`;
  if (end) {
    // DTEND is exclusive for date-only events; treat end-1day as the last day.
    const endDate = new Date(Date.UTC(end.y, end.mo - 1, end.d));
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const le = { y: endDate.getUTCFullYear(), mo: endDate.getUTCMonth() + 1, d: endDate.getUTCDate() };
    if (le.y === start.y && le.mo === start.mo && le.d > start.d) return `${s}–${le.d}`;
    if (le.y === start.y && le.mo > start.mo) return `${s} – ${MONTHS_SHORT[le.mo - 1]} ${le.d}`;
  }
  return s;
}

function monthLabel(start) {
  return `${MONTHS[start.mo - 1]} ${start.y}`;
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

function normalizeFeedEvent(ev, source) {
  const url = ev.url || source.url;
  return {
    date: ev.start.iso,
    dateLabel: dateLabel(ev.start, ev.end),
    title: ev.summary,
    venue: ev.location || "Berlin",
    type: classify(ev.summary, source.defaultType),
    eco: !!source.eco,
    confirmed: true, // it's in the organizer's own feed
    desc: (ev.description || "").slice(0, 220).trim(),
    url,
    src: hostOf(url) || source.src,
    auto: true, // marks feed-sourced entries in events.json diffs
  };
}

/* ---------------- validation / merge ---------------- */

function isValid(e, today, horizon) {
  if (!e.title || e.title.length < 3) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return false;
  const d = new Date(e.date + "T00:00:00Z");
  if (Number.isNaN(+d)) return false;
  if (d < today || d > horizon) return false;
  if (!/^https?:\/\//.test(e.url || "")) return false;
  if (!["conference", "meetup", "hackathon"].includes(e.type)) return false;
  return true;
}

function dedupeKey(e) {
  const u = (e.url || "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  // Same landing page can host several dated editions — key on url+date,
  // falling back to title+date.
  return u ? `${u}|${e.date}` : `${e.title.toLowerCase()}|${e.date}`;
}

/* ---------------- main ---------------- */

async function main() {
  const sources = JSON.parse(readFileSync(join(ROOT, "data/sources.json"), "utf8")).sources;
  const manual = JSON.parse(readFileSync(join(ROOT, "data/manual-events.json"), "utf8")).events;

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  today.setUTCDate(today.getUTCDate() - 1); // keep events happening today
  const horizon = new Date(today); horizon.setUTCMonth(horizon.getUTCMonth() + 18);

  const feedEvents = [];
  for (const source of sources) {
    if (!source.enabled || !/^https?:\/\//.test(source.url)) {
      console.log(`skip   ${source.name} (disabled or no URL)`);
      continue;
    }
    try {
      const res = await fetch(source.url, {
        headers: { "User-Agent": "berlin-devrel-calendar (personal, low-frequency iCal sync)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let parsed = parseICS(await res.text());
      if (source.berlinOnly) {
        parsed = parsed.filter((ev) => /berlin/i.test(`${ev.location} ${ev.summary} ${ev.description}`));
      }
      const normalized = parsed.map((ev) => normalizeFeedEvent(ev, source));
      console.log(`ok     ${source.name}: ${normalized.length} events`);
      feedEvents.push(...normalized);
    } catch (err) {
      // A dead feed must never wipe the calendar — log and continue.
      console.error(`ERROR  ${source.name}: ${err.message}`);
    }
  }

  // Merge: manual first, then feeds override on identical key
  const byKey = new Map();
  for (const e of manual) byKey.set(dedupeKey(e), e);
  for (const e of feedEvents) byKey.set(dedupeKey(e), e);

  const merged = [...byKey.values()]
    .filter((e) => {
      const ok = isValid(e, today, horizon);
      if (!ok) console.log(`drop   ${e.title || "(untitled)"} @ ${e.date || "?"}`);
      return ok;
    })
    .map((e) => ({ ...e, month: monthLabel({ mo: +e.date.slice(5, 7), y: +e.date.slice(0, 4) }) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out = {
    generatedAt: new Date().toISOString(),
    count: merged.length,
    events: merged,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote events.json — ${merged.length} events (${feedEvents.length} from feeds, ${manual.length} curated)`);
}

export { parseICS, normalizeFeedEvent, classify, dateLabel, parseICSDate, isValid, dedupeKey };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
