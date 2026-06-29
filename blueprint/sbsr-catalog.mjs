/**
 * sbsr-catalog.mjs — SINGLE source of truth for Sentuh Rasa products.
 *
 * Taken EXACTLY from the Sentuh Rasa menu (no invented combos):
 *   • Risoles GORENG: 3 / 6 / 12 pcs
 *   • Risoles FROZEN: 6 pcs only
 *   • Minuman, Add-on
 * The agent reads this for product knowledge; the cart tools read it for the REAL
 * price, so the LLM can never invent a price or a pack size that doesn't exist.
 */

const VARIANTS = [
  // [variant key, display name, goreng prices {3,6,12}, frozen price (6pcs), spicy?]
  { key: "ayam_sayur",   name: "Ayam Sayur",            g: { 3: 29000, 6: 55000, 12: 105000 }, f6: 55000 },
  { key: "ragout",       name: "Ragout Creamy",         g: { 3: 29000, 6: 55000, 12: 105000 }, f6: 55000 },
  { key: "smoked_beef",  name: "Smoked Beef Mayo",      g: { 3: 29000, 6: 55000, 12: 105000 }, f6: 55000 },
  { key: "mercon",       name: "Ayam Mercon Chili Oil", g: { 3: 33000, 6: 63000, 12: 120000 }, f6: 63000, hot: true },
  { key: "ayam_pedas",   name: "Ayam Sayur Pedas",      g: { 3: 29000, 6: 55000, 12: 105000 }, f6: 55000, hot: true },
];

export const CATALOG = [];
for (const v of VARIANTS) {
  for (const pack of [3, 6, 12]) CATALOG.push({ sku: `${v.key}-${pack}-grg`, variant: v.key, name: v.name, form: "goreng", pack, price: v.g[pack], cat: "risol", hot: !!v.hot });
  CATALOG.push({ sku: `${v.key}-6-frz`, variant: v.key, name: v.name, form: "frozen", pack: 6, price: v.f6, cat: "risol", hot: !!v.hot });
}
// Drinks + add-ons (single SKU each)
CATALOG.push(
  { sku: "drink-matcha", variant: "matcha", name: "Iced Matcha", form: null, pack: 1, price: 15000, cat: "drink" },
  { sku: "drink-javatea", variant: "javatea", name: "Iced Java Tea", form: null, pack: 1, price: 15000, cat: "drink" },
  { sku: "addon-chili",  variant: "chili", name: "Signature Chili Sauce 50ml", form: null, pack: 1, price: 4000, cat: "addon" },
  { sku: "addon-thermal", variant: "thermal", name: "Thermal Bag", form: null, pack: 1, price: 8000, cat: "addon" },
  { sku: "addon-icegel", variant: "icegel", name: "Ice Gel", form: null, pack: 1, price: 3000, cat: "addon" },
);

export function formatRupiah(n) { return "Rp" + (n || 0).toLocaleString("id-ID"); }

const VKEYS = VARIANTS.map(v => v.key);
function matchVariant(text) {
  const t = (text || "").toLowerCase();
  if (/mercon|chili oil/.test(t)) return "mercon";
  if (/ragout|rougut|ragu/.test(t)) return "ragout";
  if (/smoked|beef|mayo/.test(t)) return "smoked_beef";
  if (/pedas|spicy/.test(t)) return "ayam_pedas";
  if (/matcha/.test(t)) return "matcha";
  if (/java\s*tea|javatea/.test(t)) return "javatea";
  if (/chili\s*sauce|saus/.test(t)) return "chili";
  if (/thermal/.test(t)) return "thermal";
  if (/ice\s*gel/.test(t)) return "icegel";
  if (/ayam|chicken/.test(t)) return "ayam_sayur"; // plain ayam → Ayam Sayur
  return null;
}

/**
 * Resolve a product from loose params. Returns { product } OR { needs: "form"|"pack"|"variant" }
 * so the agent knows what to ASK (e.g. goreng/frozen, or 3/6/12 pcs) instead of guessing.
 */
export function resolveProduct({ product, variant, form, pack }) {
  const vkey = variant && VKEYS.concat(["matcha","javatea","chili","thermal","icegel"]).includes(variant) ? variant : matchVariant(product || variant || "");
  if (!vkey) return { needs: "variant" };
  const isRisol = VKEYS.includes(vkey);
  if (!isRisol) { // drink/add-on: single SKU
    const p = CATALOG.find(x => x.variant === vkey);
    return p ? { product: p } : { needs: "variant" };
  }
  const f = /froz/i.test(form || product || "") ? "frozen" : (/goreng|grg|matang/i.test(form || product || "") ? "goreng" : null);
  if (!f) return { needs: "form", variant: vkey };
  let pk = parseInt(pack) || (String(product || "").match(/\b(3|6|12)\s*(?:pcs|pack)?\b/) || [])[1];
  pk = parseInt(pk);
  if (f === "frozen") pk = 6; // frozen only comes in 6pcs
  if (![3, 6, 12].includes(pk)) return { needs: "pack", variant: vkey, form: f };
  const p = CATALOG.find(x => x.variant === vkey && x.form === f && x.pack === pk);
  return p ? { product: p } : { needs: "pack", variant: vkey, form: f };
}

export function catalogForPrompt() {
  let out = "## Risoles GORENG (makan langsung) — per pack 3 / 6 / 12 pcs\n";
  for (const v of VARIANTS) out += `- ${v.name}${v.hot ? " 🔥" : ""}: 3pcs ${formatRupiah(v.g[3])} / 6pcs ${formatRupiah(v.g[6])} / 12pcs ${formatRupiah(v.g[12])}\n`;
  out += "\n## Risoles FROZEN (mentah, bisa disimpan) — HANYA 6 pcs\n";
  for (const v of VARIANTS) out += `- ${v.name}${v.hot ? " 🔥" : ""}: 6pcs ${formatRupiah(v.f6)}\n`;
  out += "\n## Minuman\n- Iced Matcha: Rp15.000\n- Iced Java Tea: Rp15.000\n";
  out += "\n## Add-on\n- Signature Chili Sauce 50ml: Rp4.000\n- Thermal Bag: Rp8.000\n- Ice Gel: Rp3.000\n";
  return out.trim();
}
