// handler-agent.cjs — SBSR intent handler (runs FIRST in pipeline).
// Fully deterministic: regex patterns + DeepSeek fallback for unmatched.
// State flows: initial → ordering → awaiting_name → awaiting_address → awaiting_delivery_method
'use strict';

let _enabled = true;
function init() {}

// Patterns
const MENU_RE = /\b(?:m[eua]nu|lihat|daftar|ada\s*apa|catalog|katalog|pricelist|list\s*harga)\b/i;
const GREETING_RE = /^(?:hi|halo|hai|hallo|hello|pagi|siang|sore|malam|assalam)\b/i;
const ORDER_RE = /\b(?:pesan|order|beli|mau|pesen|mesan|pengen|ingin|butuh|bikin|coba|nyoba|nyobain)\b/i;
const RESET_RE = /\b(?:reset|mulai\s*(?:lagi|ulang)|batalkan|batalin|cancel)\b/i;
const DONE_RE = /\b(?:itu\s*aja|itu\s*saja|cukup|udah|sudah|segitu|gitu\s*aja|dulu|done|selesai|ga\s*ada|nggak\s*ada|udah\s*itu|itu\s*doang)\b/i;
const CONFIRM_RE = /^(?:ok|oke|ya|iya|lanjut|gas|siap|deal|betul|bener|benar|y|yes|okay)\b/i;
const PRODUCT_RE = /(ayam\s*sayur\s*pedas|ayam\s*sayur|smoked\s*beef\s*mayo|smoked\s*beef|ragout\s*creamy|ragout|ayam\s*mercon|mercon|chili\s*oil|creamy\s*chicken|original|mix)/i;
const QTY_RE = /(\d+)\s*(?:pcs|pack|buah|biji|box|pc|pk)/i;
const FORM_G = /\b(?:goreng|siap\s*makan|makan\s*langsung|langsung\s*makan|matang)\b/i;
const FORM_F = /\b(?:frozen|mentah|stok|beku|simpan|stock|freezer)\b/i;
const PICKUP_RE = /\b(?:pickup|pick\s*up|ambil\s*sendiri|mampir)\b/i;

function match(state, ctx) { const t = ctx.text.trim(); return _enabled && t.length >= 2 && !t.startsWith('/'); }
function capitalize(s) { return String(s||'').replace(/\b\w/g, c => c.toUpperCase()); }
function orderStatus(ctx) {
  const d=ctx.draft;
  const items=Array.isArray(d.items)?d.items:[];
  const total=items.reduce((s,it)=>s+Number(it.unit_price||0),0);
  const name=d.customer_name||'';
  const addr=d.address_text||'';
  const pin=d.gmaps_link||(d.destination?.lat?'received':'');
  const delivery=d.delivery_mode||'';
  return `📋 *Status Pesanan*\n\n`+
    `${name?'✅':'⬜'} Nama: ${name||'(belum diisi)'}\n`+
    `${addr?'✅':'⬜'} Alamat: ${addr.slice(0,50)||'(belum diisi)'}\n`+
    `${items.length>0?'✅':'⬜'} Items: ${items.length} item${items.length>1?'s':''}\n`+
    `💰 Total: Rp${Number(total).toLocaleString('id-ID')}\n`+
    `📍 PinMap: ${pin?'✅ received':'⬜ waiting...'}\n`+
    `${delivery?'✅':'⬜'} Delivery: ${delivery||'(belum dipilih)'}`;
}

async function handler(ctx) {
  // Interactive button replies → convert to text before parsing
  if (ctx.type==='interactive' && ctx.rawMsg?.interactive?.button_reply) {
    const btn=ctx.rawMsg.interactive.button_reply.id;
    if (btn==='sbsr_delivery') ctx.text='delivery';
    else if (btn==='sbsr_pickup') ctx.text='pickup';
  }
  const t = ctx.text.trim().toLowerCase();
  const cart = ctx.cart || [];
  const state = ctx.state;

  // Save conversation context for LLM
  const lastExchange = ctx.draft._last_bot_msg
    ? `[Bot sebelumnya: "${ctx.draft._last_bot_msg.slice(0,100)}"]\n[Customer sebelumnya: "${ctx.draft._last_user_msg?.slice(0,100)||''}"]`
    : '';
  ctx.updateDraft({ _last_user_msg: t.slice(0, 200) });

  ctx.log('det', `text="${t.slice(0,50)}" cart=${cart.length} state=${state}`);

  // 0. WhatsApp Location → store + fire quote
  if (t.startsWith('[location:') && cart.length>0) {
    const m=t.match(/location:\s*(-?[\d.]+),\s*(-?[\d.]+)/i);
    if (m) {
      const lat=parseFloat(m[1]),lng=parseFloat(m[2]);
      ctx.updateDraft({destination:{...ctx.draft.destination,lat,lng,source:'wa_location'},gmaps_link:`https://maps.google.com/?q=${lat},${lng}`});
      ctx.saveDraft();
      ctx.log('det',`loc lat=${lat} lng=${lng}`);
      if (ctx.draft.customer_name && ctx.draft.address_text) {
        ctx.replyText='📍 Lokasi diterima! Menghitung ongkir real-time via Biteship... 🤍';
        ctx.handled=true;
        try {
          const ah=require('../address-handler.cjs');
          const draft=ctx.draft;
          ctx.log('det','calling runQuoteFor...');
          const result=await ah.runQuoteFor(ctx.from,draft,null);
          ctx.log('det','runQuoteFor result='+(result?'ok':'null')+' quotes='+(result?.quotes?.length||0)+' keys='+(result?Object.keys(result).join(','):'null'));
          if (result && result.quotes && result.quotes.length>0) {
            const q=result.quotes[0];
            ctx.log('det',`biteship: ${q.courier||'?'} ongkir=${q.ongkir||0} label=${q.courier_label||'?'}`);
            const items=cart.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form} — Rp${Number(it.unit_price||0).toLocaleString('id-ID')}`).join('\n');
            const subtotal=cart.reduce((s,it)=>s+Number(it.unit_price||0),0);
            const ongkir=q.ongkir||0;
            const ppn=Math.round(subtotal*0.02);
            const grandTotal=subtotal+ongkir+ppn;
            await ctx.reply(`📋 *INVOICE — ${q.courier_label||q.courier||'Delivery'}*\n\n${items}\n\n💰 Subtotal: Rp${Number(subtotal).toLocaleString('id-ID')}\n🚀 Ongkir (${q.courier_label||q.courier||'Kurir'}): Rp${Number(ongkir).toLocaleString('id-ID')}\n🧾 PPN 2%: Rp${Number(ppn).toLocaleString('id-ID')}\n\n💳 *TOTAL: Rp${Number(grandTotal).toLocaleString('id-ID')}*\n\nPembayaran:\n• QRIS / GoPay / OVO\n• Transfer BCA 1234567890 a.n. Sentuh Rasa\n\n_Silahkan balas *OK* untuk lanjut pembayaran ya Kak 🤍_`);
          } else {
            ctx.log('det','biteship: no quotes returned');
            const items=cart.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form} — Rp${Number(it.unit_price||0).toLocaleString('id-ID')}`).join('\n');
            const total=cart.reduce((s,it)=>s+Number(it.unit_price||0),0);
            ctx.reply(`📍 Lokasi diterima!\n\n📋 *INVOICE*\n${items}\n\n💰 Subtotal: Rp${Number(total).toLocaleString('id-ID')}\n🚀 Ongkir: akan dihitung admin\n🧾 Estimasi Total: Rp${Number(total+20000+Math.round(total*0.02)).toLocaleString('id-ID')}\n\n_Silahkan tunggu admin konfirmasi ya Kak 🤍_`);
          }
        } catch(e) {
          ctx.log('det','biteship-err: '+e.message);
          ctx.reply('📍 Lokasi diterima! Ongkir sedang dihitung admin ya Kak 🤍');
        }
        return;
      } else { ctx.replyText='📍 Lokasi diterima Kak! 🤍'; }
      ctx.handled=true; return;
    }
  }

  // 1. Reset
  if (RESET_RE.test(t) && t.length < 15) {
    ctx.updateDraft({state:'initial',items:[],addons:[],subtotal:0,customer_name:'',address_text:'',delivery_mode:'',use_case:'',pending_product:null});
    ctx.saveDraft();
    ctx.replyText='Siap Kak! Pesanan direset ya 🤍 Mau lihat menu atau langsung order?'; ctx.handled=true; return;
  }
  // 2. Status check
  if (/\b(?:status|cek\s*pesanan|pesanan\s*saya|orderan|keranjang)\b/i.test(t) && cart.length>0) {
    ctx.replyText=orderStatus(ctx)+`\n\nKetik *cukup* kalau udah, atau tambah varian lain ya Kak 🤍`;
    ctx.handled=true; ctx.log('det','status'); return;
  }
  // 3. Menu
  if (MENU_RE.test(t) && !PRODUCT_RE.test(t)) {
    try { ctx.replyText=require('../catalog-manager.cjs').formatMenuText(); ctx.handled=true; ctx.log('det','menu'); return; } catch(_){}
  }
  // 3. FAQ (only when NOT in active flow)
  if (t.length < 60 && state!=='awaiting_delivery_method' && state!=='awaiting_name' && state!=='awaiting_address') {
    if (/\b(?:dimana|alamat|pickup|pick\s*up|ambil\s*sendiri|mampir|lokasi|maps)\b/i.test(t)) {
      ctx.replyText='📍 Sentuh Rasa — Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Jatinegara, Jakarta Timur\n🗺️ Maps: https://share.google/ykWkdLTDJgG2UVfOQ\n📞 +62 811 1321 166\n\nBisa pickup atau delivery 🤍'; ctx.handled=true; ctx.log('det','faq'); return;
    }
    if (/\bhalal\b/i.test(t)) { ctx.replyText='InsyaAllah semua produk Sentuh Rasa halal ya Kak 🤍 Sertifikasi sedang proses.'; ctx.handled=true; return; }
    if (/\b(?:tahan|awet|expired?|kadaluarsa|freezer|chiller|simpan)\b/i.test(t)) { ctx.replyText='Frozen tahan 1-2 bulan di freezer, 1-2 hari di chiller. Suhu ruang 2-3 jam 🤍'; ctx.handled=true; return; }
    if (/\b(?:cara\s+goreng|gorengnya|masaknya)\b/i.test(t)) { ctx.replyText='Goreng langsung dari frozen ya Kak. Minyak panas, api sedang, sampai golden brown 🤍'; ctx.handled=true; return; }
    if (/\b(?:reseller|agen|jualan)\b/i.test(t)) { ctx.replyText='Reseller: 4 pack Rp47rb/pack, 6 pack Rp46rb/pack, 10 pack Rp45rb/pack 🤍'; ctx.handled=true; return; }
    if (/\b(?:minimum|minimal|min\s+order)\b/i.test(t)) { ctx.replyText='Minimum order Rp50.000 ya Kak 🤍'; ctx.handled=true; return; }
    if (/\b(?:pengiriman|dikirim|kirimnya|delivery|diantar|ongkir)\b/i.test(t)) { ctx.replyText='Pengiriman dari Cipinang, Jakarta Timur. Gojek/Grab/Paxel. Ongkir dihitung setelah alamat + pin maps dikirim 🤍'; ctx.handled=true; return; }
  }

  // 4. Product order — unified parser (single + multi)
  if (PRODUCT_RE.test(t) && QTY_RE.test(t)) {
    // Find all (product, qty, form) triples in the text
    const re=new RegExp('('+PRODUCT_RE.source+')\\s*[^0-9]*(\\d+)\\s*(?:pcs|pack|buah|box|pc)?','gi');
    const triples=[];
    let m;
    while ((m=re.exec(t))!==null) {
      const prod=m[1], qty=parseInt(m[2],10)||3;
      const near=t.slice(Math.max(0,m.index-30),m.index+m[0].length+30);
      const f=FORM_F.test(near)?'frozen':FORM_G.test(near)?'goreng':'goreng';
      triples.push({prod,qty,form:f});
    }
    if (triples.length===0) {
      // Fallback: original simple match
      const variant=(t.match(PRODUCT_RE)||[])[1]||'';
      const qty=parseInt((t.match(QTY_RE)||[])[1]||'6',10);
      const form=FORM_F.test(t)?'frozen':'goreng';
      triples.push({prod:variant,qty,form});
    }
    // Build items from triples
    const d=ctx.draft;
    const existing=Array.isArray(d.items)?d.items:[];
    for (const tr of triples) {
      const name=capitalize(tr.prod)+(tr.form==='frozen'?' Frozen':'');
      const price=(tr.form==='frozen'?55000:tr.qty===3?29000:tr.qty===6?55000:tr.qty===12?105000:29000);
      existing.push({sku:tr.prod+'_'+tr.form,name,qty:tr.qty,form:tr.form,unit_price:price,pack_size:tr.form==='frozen'?12:tr.qty});
    }
    const lines=existing.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form} — Rp${Number(it.unit_price||0).toLocaleString('id-ID')}`).join('\n');
    const total=existing.reduce((s,it)=>s+Number(it.unit_price||0),0);
    ctx.updateDraft({items:existing,subtotal:total,state:'ordering',pending_product:null});
    ctx.saveDraft();
    ctx.log('det',`cart=${existing.length} total=${total} triples=${triples.length}`);
    ctx.replyText=`Siap Kak! Berikut pesanannya ya 🤍\n\n${lines}\n\n💰 Total: Rp${Number(total).toLocaleString('id-ID')}\n\nMau tambah yang lain? Atau ketik *cukup* ya Kak 🤍`;
    ctx.handled=true; ctx.log('det','order'); return;
  }

  // 5. Product without qty → save pending, ask
  if (PRODUCT_RE.test(t) && ORDER_RE.test(t) && !QTY_RE.test(t)) {
    const p=(t.match(PRODUCT_RE)||[])[1]||'';
    ctx.updateDraft({pending_product:p}); ctx.saveDraft();
    ctx.replyText=`Mau ${p} berapa pcs ya Kak? Goreng (siap makan) atau frozen (stok rumah)? 🤍`;
    ctx.handled=true; ctx.log('det','noqty'); return;
  }

  // 6. Qty+form without product → use pending_product
  if (!PRODUCT_RE.test(t) && QTY_RE.test(t) && (FORM_G.test(t)||FORM_F.test(t))) {
    const pending=ctx.draft.pending_product;
    if (pending) {
      const qty=parseInt((t.match(QTY_RE)||[])[1]||'6',10);
      const form=FORM_F.test(t)?'frozen':'goreng';
      ctx.updateDraft({pending_product:null});
      try {
        const r=await require('../agent/tools.cjs').execute('add_to_cart',{variant:pending,form,qty},ctx);
        if (r.ok) {
          const cartNow=ctx.cart||[];
          const lines=cartNow.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form} — Rp${Number(it.unit_price||0).toLocaleString('id-ID')}`).join('\n');
          const total=cartNow.reduce((s,it)=>s+(Number(it.unit_price||0)*Number(it.qty||1)/(Number(it.pack_size)||1)),0);
          ctx.updateDraft({state:'ordering'});
          ctx.replyText=`Siap Kak! Berikut pesanannya ya 🤍\n\n${lines}\n\nTotal: Rp${Number(total).toLocaleString('id-ID')}\n\nMau tambah yang lain? Atau ketik *cukup* ya Kak 🤍`;
          ctx.handled=true; ctx.log('det','pending'); return;
        }
      } catch(_){}
    }
  }

  // 7. Greeting
  if (GREETING_RE.test(t) && t.length<20) {
    ctx.replyText='Halo Kak! Selamat datang di *Sentuh Rasa — Risol Otentik* 🤍\n\nMau lihat menu, order langsung, atau tanya-tanya? Ketik aja ya~';
    ctx.handled=true; ctx.log('det','greet'); return;
  }

  // 8. Order intent without product

  // 7b. "Tambah" with existing cart
  if (/\b(?:tambah|nambah|add|lagi)\b/i.test(t) && cart.length>0 && !PRODUCT_RE.test(t)) {
    const _cl=cart.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form} — Rp${Number(it.unit_price||0).toLocaleString('id-ID')}`).join('\n');
    const _ct=cart.reduce((s,it)=>s+Number(it.unit_price||0),0);
    ctx.replyText=`Berikut keranjang Kakak ya:\n\n${_cl}\n\n💰 Total: Rp${Number(_ct).toLocaleString('id-ID')}\n\nMau tambah varian apa lagi? Atau ketik *cukup* kalau udah 🤍`;
    ctx.handled=true; ctx.log('det','addmore'); return;
  }

  if (ORDER_RE.test(t) && !PRODUCT_RE.test(t) && t.length<30) {
    ctx.replyText='Siap Kak! Ketik varian + jumlahnya ya. Contoh: "ragout creamy 3pcs" 🤍';
    ctx.handled=true; ctx.log('det','intent'); return;
  }

  // 9. Confirm / done ordering
  if (cart.length>0 && (DONE_RE.test(t) || (CONFIRM_RE.test(t) && t.length<8))) {
    const lines=cart.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form} — Rp${Number(it.unit_price||0).toLocaleString('id-ID')}`).join('\n');
    const total=cart.reduce((s,it)=>s+(Number(it.unit_price||0)*Number(it.qty||1)/(Number(it.pack_size)||1)),0);
    ctx.updateDraft({state:'awaiting_delivery_method',subtotal:total}); ctx.saveDraft();
    ctx.log('det',`📋 items=${cart.length} total=${total}`);
    // Send interactive buttons for delivery/pickup
    try {
      const wa=require('../wa-sender.cjs');
      wa.sendButtons(ctx.from,
        `📋 *Pesanan Dikonfirmasi*\n\n${lines}\n\n💰 Total: Rp${Number(total).toLocaleString('id-ID')}`,
        [{type:'reply',reply:{id:'sbsr_delivery',title:'🚀 Delivery'}},{type:'reply',reply:{id:'sbsr_pickup',title:'🏪 Pickup'}}]
      );
    } catch(_) {}
    ctx.replyText=`Mau *Delivery* (dikirim) atau *Pickup* (ambil di Cipinang) Kak? 🤍`;
    ctx.handled=true; ctx.log('det','confirm'); return;
  }
  if (cart.length===0 && DONE_RE.test(t)) {
    ctx.replyText='Belum ada pesanan nih Kak 🤍 Mau varian apa? Contoh: "ayam sayur 6pcs goreng"';
    ctx.handled=true; ctx.log('det','empty'); return;
  }

  // 10. Name (also capture address if multi-line)
  if (state==='awaiting_name' && t.length>3 && t.length<200 && !MENU_RE.test(t) && !RESET_RE.test(t)) {
    const lines=t.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
    let name='',addr='';
    for (const l of lines) {
      const nm=l.match(/^(?:nama\s*[:=]\s*)?(.+)/i);
      const ad=l.match(/(?:alamat|jl\.?|jalan|komplek|blok|gg\.?|gang)\s*[:=]?\s*(.+)/i);
      if (ad) addr=ad[1]||ad[0];
      else if (nm && !name && !/\b(?:jl|jalan|komplek|blok|no\.?\s*\d)\b/i.test(nm[1])) name=nm[1].trim();
    }
    if (!name) name=t.split(/[\n,]/)[0].replace(/[.!?,]+$/g,'').trim();
    const patch={customer_name:name};
    const isPickup=ctx.draft.delivery_mode==='pickup';
    if (addr) {
      patch.address_text=addr.replace(/\s+/g,' ');
      patch.state='confirmed';
      try { require('../wa-sender.cjs').sendLocationRequest(ctx.from,'Share lokasi kamu ya Kak buat akurasi pengiriman 📍'); } catch(_) {}
    } else if (isPickup) {
      patch.state='confirmed';
    } else {
      patch.state='awaiting_address';
    }
    ctx.updateDraft(patch); ctx.saveDraft();

    // Delivery: ask for location BEFORE invoice (need coords for Biteship)
    if (!isPickup && addr) {
      try { require('../wa-sender.cjs').sendLocationRequest(ctx.from,'Share lokasi kamu ya Kak buat akurasi pengiriman 📍'); } catch(_) {}
      ctx.replyText=`Hai Kak ${name}! Alamat dicatat ya 🤍\n\nSekarang klik tombol *Kirim Lokasi* di atas biar Mintu bisa hitung ongkir real-time & kirim invoice lengkap ya Kak~ 📍`;
    } else {
      ctx.replyText=isPickup
        ? `Hai Kak ${name}! Pesanan pickup dicatat ya 🤍\n\nTinggal datang ke Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Jatinegara. Ada yang mau diubah?`
        : `Hai Kak ${name}! 🤍 Sekarang alamat lengkap pengiriman ya. Bisa ketik manual atau share Google Maps / WhatsApp Location.`;
    }
    ctx.handled=true; ctx.log('det','name'); return;
  }

  // 11. Address
  if (state==='awaiting_address' && t.length>10 && !MENU_RE.test(t) && !RESET_RE.test(t)) {
    ctx.updateDraft({address_text:t.replace(/\s+/g,' '),state:'confirmed'}); ctx.saveDraft();
    // Fire address-and-quote (Biteship + ongkir + invoice)
    try {
      const name=ctx.draft.customer_name||'Customer';
      const ah=require('../address-handler.cjs');
      ah.tryHandleAddressAndQuote(ctx.from,[name,t].join('\n')).catch(e=>ctx.log('det','quote-err: '+e.message));
    } catch(_) {}
    // Send location request button
    try { require('../wa-sender.cjs').sendLocationRequest(ctx.from,'Share lokasi kamu ya Kak buat akurasi pengiriman 📍'); } catch(_) {}
    try { require('../wa-sender.cjs').sendLocationRequest(ctx.from,'Share lokasi kamu ya Kak buat akurasi pengiriman 📍'); } catch(_) {}
    ctx.replyText=`Alamat dicatat! 🤍\n\nSekarang klik tombol *Kirim Lokasi* di atas biar Mintu hitung ongkir real-time & kirim invoice lengkap ya Kak~ 📍`;
    ctx.handled=true; ctx.log('det','addr'); return;
  }

  // 12. Delivery (ditanya pertama setelah confirm)
  if (state==='awaiting_delivery_method') {
    if (/\b(?:delivery|dikirim|kirim|antar|gojek|grab|paxel|gosend)\b/i.test(t)) {
      ctx.updateDraft({delivery_mode:'delivery',state:'awaiting_name'}); ctx.saveDraft();
      ctx.replyText='Siap! Delivery dicatat ya Kak 🤍\n\nSekarang butuh *nama penerima* & *alamat lengkap* ya. Bisa langsung ketik.';
      ctx.handled=true; ctx.log('det','deliv'); return;
    }
    if (PICKUP_RE.test(t) || /\b(?:2|pickup)\b/i.test(t)) {
      ctx.updateDraft({delivery_mode:'pickup',state:'awaiting_name'}); ctx.saveDraft();
      ctx.replyText='Siap! Pickup di *Jl Nusa Indah Raya blok O no 10, Cipinang Muara, Jatinegara* ya Kak 🤍\n\nAtas nama siapa pesanannya?';
      ctx.handled=true; ctx.log('det','pick'); return;
    }
  }

  // 13. Fallback — unrecognized message
  ctx.log('det','unhandled');
  // Let other pipeline handlers try

}

// ── Save conversation context after handler finishes ───────────────
const _handler = module.exports.handler;
module.exports.handler = async function(ctx) {
  await _handler(ctx);
  if (ctx.handled && ctx.replyText) {
    try { ctx.updateDraft({ _last_bot_msg: ctx.replyText.slice(0, 200) }); ctx.saveDraft(); } catch(_) {}
  }
};

async function naturalOpen(ctx, hint) {
  const key=process.env.OPENROUTER_API_KEY||''; if (!key) return 'Siap Kak! Berikut pesanannya ya 🤍';
  try {
    const body=JSON.stringify({model:'deepseek/deepseek-chat',messages:[{role:'system',content:'Kamu Mintu CS Sentuh Rasa. Buat 1 kalimat pembuka NATURAL, HANGAT, singkat. JANGAN sebut produk, harga, atau total. Pakai Bahasa Indonesia kasual. Akhiri 🤍.'},{role:'user',content:hint}],max_tokens:60,temperature:0.9});
    const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,'HTTP-Referer':'https://biks.ai'},body,signal:AbortSignal.timeout(5000)});
    if (!res.ok) return 'Siap Kak! Berikut pesanannya ya 🤍';
    const d=await res.json();
    return d?.choices?.[0]?.message?.content?.trim()||'Siap Kak! Berikut pesanannya ya 🤍';
  } catch(_) { return 'Siap Kak! Berikut pesanannya ya 🤍'; }
}

async function callDeepSeek(ctx) {
  const key=process.env.OPENROUTER_API_KEY||''; if (!key) return null;
  const cart=ctx.cart||[];
  const cartStr=cart.length>0?cart.map((it,i)=>`${i+1}. ${it.name} ${it.qty}pcs ${it.form}`).join(' | '):'kosong';
  const ex = ctx.draft._last_bot_msg
    ? `\n[Konteks sebelumnya]: Bot: "${ctx.draft._last_bot_msg?.slice(0,100)}" | Customer: "${ctx.draft._last_user_msg?.slice(0,100)||''}"`
    : '';
  const prompt=`Kamu Mintu CS Sentuh Rasa. Produk: Ayam Sayur, Smoked Beef Mayo, Ragout Creamy, Ayam Mercon Chili Oil, Ayam Sayur Pedas, Mix Risol. Form: Goreng (siap makan) atau Frozen (stok).\nCart: [${cartStr}]\nState: ${ctx.state}${ex}\nCustomer sekarang: ${ctx.text}\n${cart.length>0?'Customer SUDAH order. JANGAN suruh pesan lagi.':'Tanya varian + qty + goreng/frozen.'}`;
  const body=JSON.stringify({model:'deepseek/deepseek-chat',messages:[{role:'system',content:'Kamu Mintu CS Sentuh Rasa. Natural, singkat, Bahasa Indonesia. 🤍'},{role:'user',content:prompt}],max_tokens:150,temperature:0.7});
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,'HTTP-Referer':'https://biks.ai','X-Title':'SBSR'},body,signal:AbortSignal.timeout(8000)});
  if (!res.ok) return null;
  const d=await res.json();
  const reply=d?.choices?.[0]?.message?.content?.trim()||null;
  if (reply&&/\b(?:ayam\s*suwir|kornet|keju|sosis|baso|bakso|nugget|spaghetti|pizza|burger)\b/i.test(reply)) return null;
  return reply;
}

module.exports = { init, match, handler };
