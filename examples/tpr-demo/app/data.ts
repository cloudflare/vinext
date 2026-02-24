/**
 * Deterministic product and traffic data for the TPR demo.
 *
 * Products are generated from their ID so the same ID always produces
 * the same product. Traffic follows a Zipf distribution — a realistic
 * model of how web traffic is distributed across pages.
 */

// ── Product data ─────────────────────────────────────────────

const CATEGORIES = [
  "Electronics",
  "Clothing",
  "Home & Kitchen",
  "Sports",
  "Books",
  "Toys",
  "Garden",
  "Automotive",
];

const ADJECTIVES = [
  "Premium",
  "Classic",
  "Ultra",
  "Pro",
  "Essential",
  "Deluxe",
  "Eco",
  "Smart",
  "Compact",
  "Rugged",
  "Vintage",
  "Modern",
];

const NOUNS = [
  "Widget",
  "Gadget",
  "Controller",
  "Sensor",
  "Adapter",
  "Module",
  "Station",
  "Hub",
  "Kit",
  "Pack",
  "System",
  "Device",
];

export interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  rating: number;
  reviews: number;
  description: string;
}

/** Deterministic pseudo-random from a seed. */
function seeded(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

export function getProduct(id: number): Product {
  const r = (offset: number) => seeded(id * 31 + offset);

  const adj = ADJECTIVES[Math.floor(r(1) * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(r(2) * NOUNS.length)];
  const category = CATEGORIES[Math.floor(r(3) * CATEGORIES.length)];
  const price = Math.round((4.99 + r(4) * 995) * 100) / 100;
  const rating = Math.round((3.0 + r(5) * 2.0) * 10) / 10;
  const reviews = Math.floor(r(6) * 2000);

  return {
    id,
    name: `${adj} ${noun} ${id}`,
    category,
    price,
    rating,
    reviews,
    description: `The ${adj} ${noun} ${id} is a top-rated ${category.toLowerCase()} product trusted by thousands of customers. Built with quality materials and backed by excellent customer support. Perfect for everyday use.`,
  };
}

export const TOTAL_PRODUCTS = 500;

// ── Traffic simulation (Zipf distribution) ───────────────────

export interface TrafficEntry {
  path: string;
  requests: number;
  label: string;
}

/**
 * Generate realistic traffic data using Zipf's law.
 *
 * Zipf's law states that the frequency of an item is inversely proportional
 * to its rank. This is a remarkably accurate model for web page traffic —
 * a few pages get massive traffic, and most pages get almost none.
 *
 * The exponent 0.8 produces a realistic distribution where:
 *   - Top 1% of pages → ~30% of traffic
 *   - Top 10% of pages → ~65% of traffic
 *   - Top 20% of pages → ~80% of traffic
 */
export function generateTrafficData(numPages: number): TrafficEntry[] {
  const entries: TrafficEntry[] = [];

  // Products follow Zipf distribution
  for (let rank = 1; rank <= numPages; rank++) {
    const requests = Math.round(10000 / Math.pow(rank, 0.8));
    const product = getProduct(rank);
    entries.push({
      path: `/products/${rank}`,
      requests,
      label: product.name,
    });
  }

  // Add some static pages with fixed traffic
  entries.push({ path: "/", requests: 25000, label: "Home" });
  entries.push({ path: "/about", requests: 3200, label: "About" });
  entries.push({ path: "/pricing", requests: 4800, label: "Pricing" });
  entries.push({ path: "/contact", requests: 1500, label: "Contact" });

  return entries.sort((a, b) => b.requests - a.requests);
}

/**
 * Calculate how many pages are needed to cover a given % of traffic.
 */
export function calculateCoverage(
  traffic: TrafficEntry[],
  targetPercent: number,
): {
  pagesNeeded: number;
  coveredRequests: number;
  totalRequests: number;
  coveragePercent: number;
  selectedPages: TrafficEntry[];
} {
  const totalRequests = traffic.reduce((sum, e) => sum + e.requests, 0);
  const target = totalRequests * (targetPercent / 100);

  let accumulated = 0;
  const selected: TrafficEntry[] = [];

  for (const entry of traffic) {
    if (accumulated >= target) break;
    selected.push(entry);
    accumulated += entry.requests;
  }

  return {
    pagesNeeded: selected.length,
    coveredRequests: accumulated,
    totalRequests,
    coveragePercent: (accumulated / totalRequests) * 100,
    selectedPages: selected,
  };
}
