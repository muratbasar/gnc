import { createHash } from "node:crypto";
import type { Site } from "./sites.js";

export interface SourcePage {
  excerpt: string;
  imageUrl?: string;
  title: string;
  url: string;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
}

function stripHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return decodeHtml(match);
  }
  return undefined;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "SocialPublisher/1.0 content-reader" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Kaynak sayfa ${response.status} durumuyla alınamadı.`);
  }
  return (await response.text()).slice(0, 500_000);
}

function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((match) => decodeHtml(match[1] ?? "").trim())
    .filter(Boolean);
}

function sameHost(url: string, site: Site): boolean {
  try {
    return new URL(url).hostname === new URL(site.url).hostname;
  } catch {
    return false;
  }
}

function dailyIndex(siteId: string, date: Date, length: number): number {
  const day = date.toISOString().slice(0, 10);
  const hash = createHash("sha256").update(`${siteId}:${day}`).digest();
  return hash.readUInt32BE(0) % length;
}

export class SiteSourceReader {
  async pickDailyPage(site: Site, date = new Date()): Promise<SourcePage> {
    let urls: string[] = [];
    try {
      const root = new URL("/sitemap.xml", site.url).toString();
      const locations = sitemapLocations(await fetchText(root));
      const sitemapFiles = locations
        .filter((url) => url.endsWith(".xml") || url.includes("sitemap"))
        .slice(0, 10);
      if (sitemapFiles.length) {
        const nested = await Promise.allSettled(
          sitemapFiles.map(async (url) =>
            sitemapLocations(await fetchText(url)),
          ),
        );
        urls = nested.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
      } else {
        urls = locations;
      }
    } catch {
      urls = [];
    }

    const candidates = [...new Set(urls)]
      .filter((url) => sameHost(url, site))
      .filter((url) => !/\.(jpg|jpeg|png|gif|webp|pdf)$/i.test(url));
    const url = candidates.length
      ? candidates[dailyIndex(site.id, date, candidates.length)]
      : site.url;
    if (!url) throw new Error(`${site.id} için kaynak URL bulunamadı.`);

    const html = await fetchText(url);
    const title =
      metaContent(html, "og:title") ??
      stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") ??
      site.name;
    const description =
      metaContent(html, "description") ??
      metaContent(html, "og:description") ??
      "";
    const body = stripHtml(
      html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
        html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
        html,
    );
    const image = metaContent(html, "og:image");

    return {
      excerpt: [description, body].filter(Boolean).join("\n").slice(0, 12_000),
      ...(image ? { imageUrl: new URL(image, url).toString() } : {}),
      title: title.slice(0, 300),
      url,
    };
  }
}
