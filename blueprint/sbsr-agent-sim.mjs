/**
 * sbsr-agent-sim.mjs — chat with the Sentuh Rasa agent offline.
 *   DEEPSEEK_API_KEY=sk-... node sbsr-agent-sim.mjs           # interactive
 *   DEEPSEEK_API_KEY=sk-... node sbsr-agent-sim.mjs --demo    # scripted showcase
 */
import readline from "readline";
import { runAgent } from "./sbsr-agent.mjs";
import { formatRupiah } from "./sbsr-catalog.mjs";

let state = { messages: [], order: { cart: [] } };
async function send(t) {
  console.log("\n🙍 \x1b[32m" + t + "\x1b[0m");
  const r = await runAgent(state, t); state = { messages: r.messages, order: r.order };
  console.log("🧀 " + (r.reply || "(none)"));
  if (r.order.escalate) console.log("   \x1b[33m[→ human: " + r.order.escalate + "]\x1b[0m");
}
const DEMO = ["halo", "apa yang favorit?", "buat acara kantor 10 orang enaknya apa?", "risol ayam 6pcs", "goreng", "tambah smoked beef mayo frozen", "saya udah order apa aja?", "oke cukup, dikirim ya"];

async function main() {
  if (process.argv[2] === "--demo") {
    console.log("=== DEMO: Sentuh Rasa smart agent ===");
    for (const m of DEMO) await send(m);
    const sub = (state.order.cart || []).reduce((s, i) => s + i.price * i.qty, 0);
    console.log("\n\x1b[36m=== FINAL CART (deterministic) ===\x1b[0m");
    for (const i of state.order.cart || []) console.log("  • " + i.name + " " + (i.form || "") + " " + i.pack + "pcs ×" + i.qty + " = " + formatRupiah(i.price * i.qty));
    console.log("  Subtotal: " + formatRupiah(sub) + " | fulfillment: " + (state.order.fulfillment || "-"));
    process.exit(0);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  console.log("=== Sentuh Rasa agent — chat, Ctrl-C to quit ===");
  rl.prompt(); rl.on("line", async (l) => { if (l.trim()) await send(l.trim()); rl.prompt(); });
}
main();
