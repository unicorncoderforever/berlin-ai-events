# Berlin AI Builders — DevRel Calendar

A self-updating calendar of Berlin AI conferences, meetups, and hackathons, plus an ecosystem tracker and a 2-in-person + 2-online monthly playbook.

**Total running cost: €0.** No API keys, no servers, no LLM calls.

## How it stays up to date

```
Luma / Meetup iCal feeds ──┐
                           ├─→ scripts/update-events.mjs ─→ events.json ─→ git commit ─→ Vercel redeploys
data/manual-events.json ───┘        (GitHub Action, every 2 days)
```

- `data/sources.json` — iCal feeds pulled automatically (Meetup groups work out of the box; Luma calendars need their iCal URL pasted in once, see below). Feed events are marked **Confirmed** since they come from the organizer's own calendar.
- `data/manual-events.json` — hand-curated entries for things with no feed (big conferences, TBA items). Edit this file directly to add or fix events.
- `events.json` — generated output; the site fetches it on load. Don't edit by hand.
- The workflow in `.github/workflows/update-events.yml` runs every 2 days, and only commits when something actually changed. If a feed is down, that run just logs an error — the existing data is never wiped.

## Setup (one time, ~10 minutes)

1. **Create a public GitHub repo** and push these files. (Public = unlimited free Actions minutes.)
2. **Import the repo into Vercel** (free Hobby plan) as a static site — no build step needed. Every commit auto-deploys.
3. **Enable the workflow**: repo → Actions tab → enable workflows → run "Update events" once manually to generate the first `events.json`.
4. **Add the Luma feeds** (optional but recommended): open each Luma calendar (e.g. `luma.com/aiagentsberlin`), click **Subscribe** → copy the iCal URL (looks like `https://api.lu.ma/ics/get?entity=calendar&id=cal-…`), paste it into `data/sources.json`, and set `"enabled": true`.

## Everyday maintenance

- **Add a conference or one-off event**: append an object to `data/manual-events.json` and push. Schema:

```json
{
  "date": "2026-12-03",
  "dateLabel": "Dec 3",
  "title": "Event name",
  "venue": "Venue, Berlin",
  "type": "conference | meetup | hackathon",
  "eco": false,
  "confirmed": true,
  "desc": "One-sentence description.",
  "warn": "(optional) caveat shown on the card",
  "url": "https://…",
  "src": "example.com"
}
```

- **Add a new feed**: add an entry to `data/sources.json`. `defaultType` is used when the event title doesn't reveal the type; `"berlinOnly": true` filters multi-city calendars down to events mentioning Berlin.
- **Run locally**: `node scripts/update-events.mjs` (Node 18+), then open `index.html` via any static server (`npx serve .`).

## Notes on being a good citizen

The updater hits each feed at most once every 2 days with an identifying User-Agent — well within what Luma and Meetup expect from calendar subscribers (iCal subscribe is the sanctioned access path, which is why this setup avoids HTML scraping entirely). If you later add sources that only exist as web pages, check their robots.txt and terms first.
