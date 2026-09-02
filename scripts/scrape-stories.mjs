import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = join(ROOT, "data", "stories.json");
const TIMES_PATH = join(ROOT, "data", "times-stories.json");
const INDEX_PATH = join(ROOT, "index.html");

const NYT_AUTHOR = "https://www.nytimes.com/by/ademola-bello";
const TIMES_AUTHOR = "https://www.thetimes.com/profile/ademola-bello";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const NAV_TIMEOUT = 60_000;

// Derive a date from an NYT article URL. Full form is /YYYY/MM/DD/; the
// election-hub interactives only carry a year, so fall back to Jan 1 of it.
function dateFromNytUrl(url) {
  const full = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const year = url.match(/\/(\d{4})\//);
  if (year) return `${year[1]}-01-01`;
  return "";
}

// Noise categories to keep out of the published list. The flagship work lives
// in the hand-curated portfolio grid; this sidebar is the broader archive, but
// these two auto-generated series add nothing:
//   - NYT: "Election 2024 Polls: <state>" pages (dozens of near-identical ones)
//   - The Times: weekly "The Times quiz of the week ..." posts
function isExcluded(s) {
  if (/^Election\s+\d{4}\s+Polls:/i.test(s.title)) return true;
  if (/^new?s?\s+quiz$/i.test((s.kicker || "").trim())) return true;
  if (/times quiz of the week/i.test(s.title)) return true;
  return false;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupe(stories) {
  const byUrl = new Set();
  const byTitle = new Set();
  const out = [];
  for (const s of stories) {
    const url = s.url.split("?")[0].replace(/\/$/, "");
    const titleKey = normalizeTitle(s.title);
    if (!url || !s.title) continue;
    if (byUrl.has(url) || byTitle.has(titleKey)) continue;
    byUrl.add(url);
    byTitle.add(titleKey);
    out.push({ ...s, url });
  }
  return out;
}

async function scrapeNYT(page) {
  await page.goto(NYT_AUTHOR, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await page.waitForSelector("#featured, #latest", { timeout: 30_000 });
  const raw = await page.evaluate(() => {
    const results = [];
    const isArticle = (href) => /\/(19|20)\d\d\/|\/interactive\//.test(href);

    document.querySelectorAll('#featured [class*="_assetWrapper"] > li').forEach((li) => {
      const heading = li.querySelector("h2, h3");
      const anchor = li.querySelector("a[href]");
      if (heading && anchor && isArticle(anchor.href)) {
        results.push({ title: heading.textContent.trim(), url: anchor.href });
      }
    });

    document.querySelectorAll("#latest a[href]").forEach((anchor) => {
      const title = (anchor.textContent || "").trim();
      if (title.length > 15 && isArticle(anchor.href)) {
        results.push({ title, url: anchor.href });
      }
    });

    return results;
  });

  return raw.map((s) => ({
    title: s.title,
    url: s.url,
    kicker: "",
    date: dateFromNytUrl(s.url),
    org: "The New York Times",
  }));
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthLabel = m && months[Number(m) - 1] ? `${months[Number(m) - 1]} ` : "";
  return `${monthLabel}${y}`;
}

function renderItem(s) {
  const date = s.date
    ? `<span class="more-stories__date">${escapeHtml(formatDate(s.date))}</span>`
    : "";
  return (
    `          <li class="more-stories__item">` +
    `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>${date}</li>`
  );
}

function renderGroup(label, stories) {
  if (!stories.length) return "";
  const items = stories.map(renderItem).join("\n");
  return (
    `        <div class="more-stories__group">\n` +
    `          <p class="more-stories__outlet">${escapeHtml(label)}</p>\n` +
    `          <ul class="more-stories__list">\n${items}\n          </ul>\n` +
    `        </div>`
  );
}

function renderSidebar(stories) {
  const nyt = stories.filter((s) => s.org === "The New York Times");
  const times = stories.filter((s) => s.org === "The Times & Sunday Times");

  return (
    "\n" +
    renderGroup("The New York Times", nyt) +
    "\n" +
    renderGroup("The Times & Sunday Times", times) +
    "\n" +
    `        <p class="more-stories__all">` +
    `<a href="${NYT_AUTHOR}">View all on the NYT</a> &middot; ` +
    `<a href="${TIMES_AUTHOR}">The Times</a></p>\n      `
  );
}

function injectIntoIndex(sidebarHtml) {
  const html = readFileSync(INDEX_PATH, "utf8");
  const start = "<!-- STORIES:START -->";
  const end = "<!-- STORIES:END -->";
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(html)) {
    throw new Error(`Markers ${start} / ${end} not found in index.html`);
  }
  writeFileSync(INDEX_PATH, html.replace(pattern, `${start}${sidebarHtml}${end}`));
}

function loadFrozenTimes() {
  const parsed = JSON.parse(readFileSync(TIMES_PATH, "utf8"));
  return Array.isArray(parsed.stories) ? parsed.stories : [];
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let nyt = [];
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 1600 },
      locale: "en-GB",
    });
    const page = await context.newPage();
    nyt = await scrapeNYT(page).catch((e) => {
      console.error("NYT scrape failed:", e.message);
      return [];
    });
  } finally {
    await browser.close();
  }

  // Abort loudly on an empty NYT scrape, so a layout change or bot block
  // surfaces as a red CI run instead of silently wiping output.
  if (nyt.length === 0) {
    throw new Error("Refusing to write output: NYT scrape returned nothing.");
  }

  const times = loadFrozenTimes();
  console.log(`Scraped NYT=${nyt.length}; frozen Times=${times.length}`);

  const stories = dedupe([...nyt, ...times])
    .filter((s) => !isExcluded(s))
    .sort((a, z) => (z.date || "").localeCompare(a.date || ""));

  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(
    DATA_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sources: { "The New York Times": nyt.length, "The Times & Sunday Times": times.length },
        count: stories.length,
        stories,
      },
      null,
      2,
    ) + "\n",
  );

  injectIntoIndex(renderSidebar(stories));
  console.log(`Wrote ${stories.length} stories to data/stories.json and updated index.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
