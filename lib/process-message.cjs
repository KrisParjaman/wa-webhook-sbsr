// process-message.cjs
'use strict';

let _S, _M, _L, _LD, _SD, _sec, _adm, _ec, _ep, _llm, _AP;
function init(o){
  _S=o.sendToOpenClaw||function(){return''};
  _M=o.sendMessage||function(){};
  _L=o.log||console.log.bind(console);
  _LD=o.loadDraft||function(){return{}};
  _SD=o.saveDraft||function(){};
  _sec=o.secLib||{sanitizeUserText:function(t){return{clean:t,flags:[],blocked:false}},summarizeFlags:function(){return'clean'}};
  _adm=o.admin||{logIncoming:function(){},logOutgoing:function(){},isPaused:function(){return false}};
  _ec=o.engineCtx||null;
  _ep=o.enginePipeline||null;
  _llm=o.sbsrLlmClassifierEnabled!==undefined?o.sbsrLlmClassifierEnabled:true;
  _AP=o.ADMIN_PHONES||'';
}

async function _processMessage(msg, from, messageId, contactName) {

    let userText = "";
    if (msg.type === "text") {
      const _raw = msg.text.body || "";
      // === BIKS SECURITY: SANITIZE INBOUND TEXT ===
      if (_sec) {
        const _sec = _sec.sanitizeUserText(_raw);
        if (_sec.flags.length) {
          try {
            fs.appendFileSync(SECURITY_FLAGS_FILE,
              JSON.stringify({ ts: new Date().toISOString(), from, flags: _sec.flags, blocked: _sec.blocked, sample: String(_raw).slice(0, 200) }) + "\n");
          } catch (e) { console.error("[security] flag-log err:", e.message); }
          _L("security", from + " " + _sec.summarizeFlags(_sec));
        }
        if (_sec.blocked) {
          try { await _M(from, "Maaf Kak, pesannya nggak bisa diproses 🙏 coba kirim ulang ya"); } catch (_) {}
          return;
        }
        userText = _sec.clean;
      } else {
        userText = _raw;
      }
      // === END BIKS SECURITY ===
    }
    else if (msg.type === "audio" || msg.type === "voice") { await _M(from, "Maaf, gw belum bisa proses voice message. Kirim text aja ya."); return; }
    else if (msg.type === "image") {
      const imgResult = await handleImageMessage(msg);
      if (imgResult.url) {
        // Run OCR at bridge level so bot can't hallucinate "link keblok"
        _L("ocr-bridge", "Running OCR on " + imgResult.url);
        const ocr = await runReceiptOCR(imgResult.url, imgResult.imgbbUrl);
        const ocrBlock = formatOCRForBot(ocr);
        userText = "[Receipt/Image: " + imgResult.url + "]" + (imgResult.text ? "\nCaption: " + imgResult.text : "");
        if (ocrBlock) userText += "\n" + ocrBlock;
        _L("ocr-bridge", "OCR " + (ocr ? "ok merchant=" + (ocr.merchant || "?") + " total=" + (ocr.total || "?") : "FAILED — bot will see image URL only"));
        try {
          if (!ocr) {
            if (await tryHandleBuktiOcrFailedManualReview(from, imgResult.url)) {
              _L("intercept", "tryHandleBuktiOcrFailedManualReview " + from);
              sendReaction(from, messageId, "").catch(() => {});
              return;
            }
          }
        } catch (e) { _L("sbsr-bukti", "ocr-failed intercept err: " + e.message); }
        try {
          if (await tryHandleBuktiAuto(from, ocr, imgResult.url)) {
            _L("intercept", "tryHandleBuktiAuto " + from);
            _L("sbsr-bukti", "Handled bukti deterministically, skipping LLM");
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
        } catch (e) { _L("sbsr-bukti", "intercept err: " + e.message); }
      } else {
        userText = imgResult.text ? "[Image with caption: " + imgResult.text + "]" : "[Image received]";
        if (imgResult.error) userText += " (image processing failed: " + imgResult.error + ")";
      }
    }
    else if (msg.type === "document") userText = "[Document: " + (msg.document?.filename || "unknown") + "]";
    else if (msg.type === "location") {
      if (await tryHandleWhatsAppLocation(from, msg.location || {})) {
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      userText = "[Location: " + msg.location?.latitude + ", " + msg.location?.longitude + "]";
    }
    else if (msg.type === "order") {
      // Handle WhatsApp catalog orders
      const orderItems = msg.order?.product_items || [];
      // Persist items+prices+subtotal directly to draft so addons (chili/tea/matcha)
      // are not silently dropped by the cart-sniff regex (which is Risol-only).
      // Without this, bukti-amount mismatches (root cause of yesterday's 262k vs 192k bug).
      const draftItems = orderItems.map((item, i) => {
        const name = lookupProductName(item.product_retailer_id) || "Item " + (i + 1);
        const qty = item.quantity || 1;
        const unit_price = item.item_price || 0;
        const isRisol = /^Risol/i.test(name);
        const pack_size = /12\s*pcs/i.test(name) ? 12 : (isRisol ? 6 : null);
        const form = /Frozen/i.test(name) ? "frozen" : (isRisol ? "goreng" : null);
        return { name, qty, unit_price, pack_size, form, sku: item.product_retailer_id };
      });
      let subtotal = draftItems.reduce((s, it) => s + (it.unit_price * it.qty), 0);
      try {
        const existing = _LD(from) || { phone: from };
        const _inAddMoreMode = !!existing.add_more_mode;
        const _oldItemsForMerge = Array.isArray(existing.items) ? existing.items : [];
        if (_inAddMoreMode) {
          const _byKey = new Map();
          const _push = (it) => {
            if (!it) return;
            const key = String(it.sku || it.name || '').trim().toLowerCase();
            const prev = _byKey.get(key);
            if (prev) {
              prev.qty = Number(prev.qty || 0) + Number(it.qty || 0);
              if (!prev.unit_price && it.unit_price) prev.unit_price = it.unit_price;
            } else {
              _byKey.set(key, { ...it, qty: Number(it.qty || 0) });
            }
          };
          _oldItemsForMerge.forEach(_push);
          draftItems.forEach(_push);
          const _merged = Array.from(_byKey.values());
          _L("sbsr-cart-merge", "old_items=" + _oldItemsForMerge.length);
          _L("sbsr-cart-merge", "new_items=" + draftItems.length);
          _L("sbsr-cart-merge", "merged_items=" + _merged.length);
          draftItems.length = 0;
          _merged.forEach(it => draftItems.push(it));
          subtotal = draftItems.reduce((s, it) => s + ((Number(it.unit_price) || 0) * (Number(it.qty) || 0)), 0);
        }
        // --- Availability check: reject order if any item is out of stock ---
        const unavailableItems = [];
        for (const it of draftItems) {
          const avail = lookupProductAvailability(it.sku);
          if (avail && avail !== "in stock" && avail !== "available for order") {
            unavailableItems.push(it.name);
          }
        }
        if (unavailableItems.length > 0) {
          const itemList = unavailableItems.map(n => "\u2022 " + n).join("\n");
          await _M(from,
            "Maaf Kak, produk berikut sedang tidak tersedia saat ini:\n\n" + itemList +
            "\n\nSilakan pilih menu lain dari katalog ya \uD83D\uDE4F"
          );
          sendWhatsAppCata_L(from).catch(function(){});
          return;
        }
        const priorTerminal = !!existing.invoice_sent_at
          || ["awaiting_invoice_confirm","awaiting_proof","pending_finance","approved","BOOKED","booked","delivered","cancelled"].includes(existing.state);
        // Decide whether to wipe prior state for the new catalog order.
        // Original logic only handled terminal states; 2026-05-07 QA found a bug
        // where a customer who abandoned a cart at "awaiting_address" 24h+ ago
        // got their old gmaps_link silently re-used for a new order (shipping
        // to wrong destination). draft-policy.cjs.shouldResetDraftForCatalogOrder
        // adds a stale-incomplete check on top. Falls back to legacy logic when
        // _sec didn't load.
        const _resetDecision = _inAddMoreMode
          ? { reset: false, reason: 'add-more-preserve' }
          : (_sec && _sec.draftPolicy
            ? _sec.draftPolicy.shouldResetDraftForCatalogOrder(existing)
            : { reset: !!existing.invoice_sent_at
                || ["awaiting_invoice_confirm","awaiting_proof","pending_finance","approved","BOOKED","booked","delivered","cancelled"].includes(existing.state),
                reason: 'fallback-legacy' });
        const freshStart = _resetDecision.reset ? {
          customer_name: null,
          customer_name_set_at: null,
          gmaps_link: null,
          gmaps_link_seen_at: null,
          destination: null,
          pending_address_text: null,
          pending_address_text_at: null,
          location_resolve_fails: 0,
          location_admin_notified_at: null,
          last_failed_url: null,
        } : {};
        if (_resetDecision.reset) {
          _L("sbsr-catalog-persist", "fresh-start detected for " + from + " (reason=" + _resetDecision.reason + ", prior state=" + existing.state + ", invoice=" + !!existing.invoice_sent_at + ") — clearing name/url/destination");
        }
        const _existingUseCase = String(existing.use_case || "").trim().toLowerCase();
        const _hasFrozenInOrder = draftItems.some((it) => it && it.form === "frozen");
        const _inferredMode = inferCatalogProductMode(draftItems);
        if (_inferredMode === "goreng") _L("sbsr-product-infer", "mode=goreng");
        if (_inferredMode === "frozen") _L("sbsr-product-infer", "mode=frozen");
        if (_inferredMode === "mixed") _L("sbsr-product-infer", "mode=mixed");
        const _inferredUseCase = _inferredMode === "goreng"
          ? "makan-langsung"
          : (_inferredMode === "frozen" ? "stock_frozen" : (_inferredMode === "mixed" ? "mixed_needs_clarification" : null));
        const _catalogPriority = String(existing.state || "").trim().toLowerCase() === "awaiting_usecase" && !!_inferredMode;
        const _nextStateAfterOrder = _catalogPriority
          ? (_inferredMode === "mixed" ? "awaiting_usecase" : "awaiting_addon_reply")
          : (!existing.use_case
              ? "awaiting_usecase"
              : ((_existingUseCase === "stock_frozen" && !_hasFrozenInOrder
                  ? "awaiting_product_selection"
                  : "awaiting_addon_reply")));
        _SD(from, {
          ...existing,
          items: draftItems,
          subtotal,
          cart_sniffed_at: new Date().toISOString(),
          catalog_order: true,
          state: _nextStateAfterOrder,
          ...( _catalogPriority ? {
            inferred_product_mode: _inferredMode,
            use_case: _inferredUseCase,
            use_case_source: "catalog_infer",
            use_case_set_at: new Date().toISOString(),
            awaiting_usecase: null,
            pending_usecase_prompt: null,
            pending_menu_prompt: null,
            menu_interrupt_pending: null,
            pending_use_case_reminder: null,
            pending_product_reminder: null,
            pending_frozen_reminder: null,
          } : {}),
          // reset prior-order state so deterministic flow re-fires:
          grand_total: null,
          expected_total: null,
          ongkir: null,
          courier: null,
          courier_label: null,
          courier_type: null,
          eta_text: null,
          frozen: null,
          quote_at: null,
          invoice_sent_at: null,
          payment_sent_at: null,
          payment_order_key: null,
          qris_sent_for_order_key: null,
          add_more_mode: null,
          awaiting_add_more_confirm: null,
          bukti_url: null,
          bukti_amount: null,
          bukti_bank: null,
          bukti_mismatch_at: null,
          pending_bridge_context: null,
          last_escalation_turn: null,
          ...freshStart,
        });
        _L("sbsr-catalog-persist", "saved " + draftItems.length + " items for " + from + " subtotal=" + subtotal + (priorTerminal ? " (fresh-start reset)" : " (state reset)"));
        if (_inAddMoreMode) _L("sbsr-invoice", "invalidated_due_add_more");
        if (_catalogPriority) {
          _L("sbsr-catalog-order", "cancel_usecase_prompt");
          if (_inferredUseCase) _L("sbsr-usecase", "inferred_from_catalog=" + _inferredUseCase);
          _L("sbsr-router", "catalog_selection_priority=true");
          _L("sbsr-router", "skip_stale_usecase_prompt");
        }
      } catch (e) { _L("sbsr-catalog-persist", "save err: " + e.message); }

      // #4 SBSR_CART_V2 — when cart changes mid-flow with destination already resolved,
      // deterministically re-quote + re-invoice. Skips LLM round-trip, prevents stale totals.
      // Default OFF (env unset) — flip SBSR_CART_V2=true to enable.
      if (process.env.SBSR_CART_V2 === 'true') {
        try {
          const updated = _LD(from);
          if (updated?.customer_name && updated?.destination?.gmaps_link && Array.isArray(updated.items) && updated.items.length > 0) {
            const syntheticText = [
              updated.customer_name,
              updated.destination.address_text || "(alamat dari pin)",
              updated.destination.gmaps_link,
            ].join("\n");
            _L("sbsr-cart-v2", "auto-requote fire for " + from + " (cart=" + updated.items.length + " items, dest known)");
            const handled = await tryHandleAddressAndQuote(from, syntheticText).catch(e => {
              _L("sbsr-cart-v2", "tryHandleAddressAndQuote err: " + e.message); return false;
            });
            if (handled) {
              _L("sbsr-cart-v2", "auto-requote handled for " + from + ", skipping LLM");
              sendReaction(from, messageId, "").catch(() => {});
              return; // deterministic path took over
            }
            _L("sbsr-cart-v2", "auto-requote did not handle, falling through to LLM");
          }
        } catch (e) { _L("sbsr-cart-v2", "err: " + e.message); }
      }

      const itemLines = draftItems.map(it => it.name + " x" + it.qty + " (Rp" + (it.unit_price || 0).toLocaleString("id-ID") + ")").join(", ");
      _L("order", "Catalog order from " + from + ": " + itemLines + " subtotal=" + subtotal);
      try {
        const existing = _LD(from) || { phone: from };
        const latestDraft = _LD(from) || {
          phone: from,
          items: draftItems,
          subtotal,
          state: !existing.use_case
            ? "awaiting_usecase"
            : ((String(existing.use_case || "").trim().toLowerCase() === "stock_frozen" && !draftItems.some((it) => it && it.form === "frozen")
                ? "awaiting_product_selection"
                : "awaiting_addon_reply")),
        };
        if (existing.use_case) {
          const existingUseCase = String(existing.use_case || "").trim().toLowerCase();
          const hasFrozenInOrder = Array.isArray(latestDraft.items) && latestDraft.items.some((it) => it && it.form === "frozen");
          if (existingUseCase === "stock_frozen" && !hasFrozenInOrder) {
            await _M(from, "Untuk stock frozen, pilih dulu item frozen/mix frozen dari katalog ya Kak 🤍");
          } else {
            await sendSbsrAddonOffer(from, latestDraft);
            _L("sbsr-addon", "offer_after_product_selection");
          }
        } else {
          const inferredMode = String(latestDraft.inferred_product_mode || "");
          if (inferredMode) {
            _L("sbsr-catalog-order", "cancel_usecase_prompt");
            _L("sbsr-router", "catalog_selection_priority=true");
            _L("sbsr-router", "skip_stale_usecase_prompt");
            if (inferredMode === "mixed" || String(latestDraft.use_case || "") === "mixed_needs_clarification") {
              await _M(from, "Kak, ini untuk langsung disantap, stock frozen, meeting/acara, atau gift/hampers ya?");
            } else {
              await sendSbsrAddonOffer(from, latestDraft);
              _L("sbsr-addon", "offer_after_product_selection");
            }
          } else {
            // No use_case and no inferred mode — check if already waiting
            var _prevState = String(existing.state || "").trim().toLowerCase();
            if (_prevState === "awaiting_usecase") {
              // Customer already saw use-case prompt, now picked from catalog.
              // Skip use-case: auto-set to "makan-langsung" and go straight to addon
              var _autoUseCase = "makan-langsung";
              var _hasFrozenInCart = Array.isArray(latestDraft.items) && latestDraft.items.some(function(it) { return it && it.form === "frozen"; });
              var _nextDraft = { ...latestDraft, use_case: _autoUseCase, use_case_source: "auto_from_catalog", use_case_set_at: new Date().toISOString() };
              _SD(from, _nextDraft);
              _L("sbsr-catalog-order", "no_use_case_but_awaiting — auto use_case=" + _autoUseCase + " → addon");
              await sendSbsrAddonOffer(from, _nextDraft);
              _L("sbsr-addon", "offer_after_auto_use_case");
            } else {
              // Fresh start — send confirmation + use-case prompt
              var _itemSummary = (latestDraft.items || []).map(function(it) {
                return (it.name || "item") + " x" + (it.qty || 1);
              }).join(", ");
              await _M(from, "Mintu catat ya Kak: " + _itemSummary + " \u{1f90d}\n\n" +
                "Untuk kebutuhan apa nih pesanannya?\n" +
                "1. Makan langsung\n2. Stock frozen\n3. Meeting/acara\n4. Gift/hampers");
              _L("sbsr-catalog-order", "no_use_case_fresh — sent confirmation + use-case");
            }
            _L("sbsr-order-flow", "waiting_usecase");
            var _coCtx = "Customer baru pilih dari katalog. " +
              "Kamu SUDAH tanya use-case (1-4). TUNGGU customer pilih. JANGAN tanya lagi.";
            setPendingBridgeContext(from, _coCtx);
          }
        }
        sendReaction(from, messageId, "").catch(() => {});
        return;
      } catch (e) {
        _L("sbsr-order-flow", "usecase prompt send err: " + e.message);
      }
    }
    else if (msg.type === "interactive") {
      // Handle interactive message replies (list selections, buttons)
      if (msg.interactive?.type === "list_reply") {
        // Send both title and ID so SOUL can map either format
        const listId = msg.interactive.list_reply.id || "";
        const listTitle = msg.interactive.list_reply.title || listId;
        userText = listTitle + (listId && listId !== listTitle ? " [" + listId + "]" : "");
      } else if (msg.interactive?.type === "button_reply") {
        const btnId = msg.interactive.button_reply.id || "";
        const btnTitle = msg.interactive.button_reply.title || btnId;
        // SBSR Finance dropdown — synthesize "<verb> <suffix>" so tryHandleAdminCmd matches
        const finBtn = btnId.match(/^sbsr_(approve|reject)_(\d{4,})$/);
        if (finBtn) {
          userText = finBtn[1].toUpperCase() + " " + finBtn[2];
        } else {
          userText = btnTitle;
        }
      } else if (msg.interactive?.type === "product_list_reply") {
        userText = "[Customer selected product from list]";
      } else {
        userText = "[Interactive: " + (msg.interactive?.type || "unknown") + "]";
      }
    }
    else if (msg.type === "sticker") userText = "[Sticker received]";
    else if (msg.type === "reaction") return;
    else userText = "[" + msg.type + " message received]";

    if (!userText) return;
    _L("msg", contactName + " (" + from + "): " + userText);
    safeLog(_adm.logIncoming, from, userText || ("[" + msg.type + "]"), contactName);
    // Admin pause: silent drop before typing + interceptors.
    // Admin panel resume → isPaused=false → bot responds again.
    if (_adm && typeof _adm.isPaused === "function" && _adm.isPaused(from)) {
      return;
    }

    sendTypingIndicator(from, messageId).catch(() => {});
    // Admin/Finance/Kitchen number lockdown (per user request 2026-05-05).
    // +6285741844938 (in SBSR_FINANCE_PHONES) is _adm-only — never a customer.
    // Run _adm-cmd intercept (APPROVE/REJECT/slash). Anything else from this number
    // is silently dropped: no LLM, no catalog, no cart-sniff, no auto-quote, no bukti.
    // Use a separate test number for customer-side demos (e.g. +4915204107177).
    if (_AP.includes(from)) {
      // ── Classifier toggle (live, no restart) ──────────────────
      const _cfToggle = String(userText || "").trim().toLowerCase();
      if (_cfToggle === "/classifier_on") {
        _llm = true;
        _L("llm-classifier", "ENABLED by _adm " + from);
        await _M(from, "Classifier ON \u{1f7e2} — LLM akan klasifikasi intent customer.");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (_cfToggle === "/classifier_off") {
        _llm = false;
        _L("llm-classifier", "DISABLED by _adm " + from);
        await _M(from, "Classifier OFF \u{1f534} — fallback ke regex pipeline.");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (_cfToggle === "/classifier_status") {
        await _M(from, "Classifier: " + (_llm ? "ON \u{1f7e2}" : "OFF \u{1f534}"));
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      // ── End classifier toggle ────────────────────────────────
      try {
        if (await tryHandleAdminCmd(from, userText)) {
          _L("intercept", "tryHandleAdminCmd " + from);
          sendReaction(from, messageId, "").catch(() => {});
          _L("sbsr-_adm-lockdown", "_adm cmd handled");
          return;
        }
      } catch (e) { _L("sbsr-_adm-lockdown", "_adm-cmd err: " + e.message); }
      try {
        if (await tryHandleKitchenReady(from, userText)) {
          _L("intercept", "tryHandleKitchenReady " + from);
          sendReaction(from, messageId, "").catch(() => {});
          _L("sbsr-_adm-lockdown", "kitchen ready ack handled");
          return;
        }
      } catch (e) { _L("sbsr-_adm-lockdown", "kitchen-ready err: " + e.message); }
      _L("sbsr-_adm-lockdown", "_adm non-cmd falls through: " + userText.slice(0, 80));
      // Not an _adm command - let through to customer flow
    }

    // Bridge-level handlers (run BEFORE LLM to avoid hallucinated tool calls)
    // Greeting/menu intercept must stay first so simple salutations never fall
    // through to OpenClaw, Qdrant-era retrieval layers, OCR, or approval flows.
    if (msg.type === "text") {
      const _preDraftForMenu = _LD(from) || {};
      const _activeCheckoutForMenu = isSbsrCheckoutCollectionActive(_preDraftForMenu);
      const _preStateForMenu = String(_preDraftForMenu.state || "").trim().toLowerCase();
      let _cfRan = false; // true kalau classifier udah sukses analisis (skip isRestartIntent)
      // ── Pipeline v2 (sole handler for ALL text messages) ──────────
      try { _initEngine(); } catch (_) {}
      try {
        var _v2ctx = _ec ? _ec.createContext({
          from: from, messageId: messageId, contactName: contactName,
          rawText: userText, msgType: msg.type, rawMsg: msg,
        }) : null;
        if (_v2ctx && _ep) {
          await _ep.runPipeline(_v2ctx);
        }
        sendReaction(from, messageId, "").catch(function(){});
        return; // pipeline is the sole handler
      } catch (_pipelineErr) {
        _L("pipeline", "fatal: " + (_pipelineErr && _pipelineErr.message || "?"));
        sendReaction(from, messageId, "").catch(function(){});
        return;
      }
    }
    // === DELIVERY CONFIRMATION INTERCEPT ===
    if (await tryHandleDeliveryConfirm(from, userText)) {
      _L("intercept", "tryHandleDeliveryConfirm " + from);
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }
    // INTERACTIVE BUTTON HANDLER: "ya_lanjut" → transition to delivery method
    if (msg.type === "interactive" && msg.interactive && msg.interactive.button_reply) {
      const _btnId = msg.interactive.button_reply.id;
      if (_btnId === "ya_lanjut") {
        const _bd = _LD(from) || {};
        const _bItems = (Array.isArray(_bd.items) && _bd.items.length > 0) || (_bd.cart && Array.isArray(_bd.cart.items) && _bd.cart.items.length > 0);
        if (_bItems) {
          _SD(from, { ..._bd, state: "awaiting_delivery_method" });
          await sendSbsrDeliveryMethodButtons(from);
          _L("sbsr-interactive", "ya_lanjut -> delivery_method");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // No items in draft — try pending_items (from classifier) or summary
        let _pendingItems = Array.isArray(_bd.pending_items) ? _bd.pending_items : [];
        const _summary = _bd.pending_order_summary || '';
        if (_pendingItems.length > 0 || _summary) {
          const _form = String(_bd.use_case || "").includes("frozen") ? 'frozen' : 'goreng';
          let _built;
          if (_pendingItems.length > 0) {
            _built = buildItemsFromPending(_pendingItems, _form);
            _L('sbsr-interactive', 'ya_lanjut -> ' + _built.items.length + ' items subtotal=' + _built.subtotal + ' from pending_items');
          } else {
            const _priceM = _summary.match(/Rp\s*([\d.]+)/);
            const _price = _priceM ? parseInt(_priceM[1].replace(/\./g, ''), 10) : 0;
            const _summaryHead = _summary.split(/\b(?:Harga|price|list|Rp\s*\d)/i)[0];
            const _mixM = _summaryHead.match(/Mix\s+(\d+)\s*pcs/i);
            let _pack = 6;
            if (_mixM) { _pack = parseInt(_mixM[1], 10); } else {
              const _pcsRe = /(\d+)\s*pcs/gi; let _t = 0, _m;
              while ((_m = _pcsRe.exec(_summaryHead)) !== null) _t += parseInt(_m[1], 10);
              _pack = _t > 0 ? _t : 6;
            }
            _built = { items: [{name:'Risol ' + (_form==='frozen'?'Frozen':'Goreng') + ' — Mix '+_pack+'pcs', qty:1, pack_size:_pack, unit_price:_price, form:_form}], subtotal:_price, pack:_pack };
          }
          _SD(from, { ..._bd, items: _built.items, subtotal: _built.subtotal, pending_order_summary:null, pending_items:null, state:'awaiting_delivery_method' });
          _L('sbsr-interactive', 'ya_lanjut -> created draft items=' + _built.items.length + ' subtotal=' + _built.subtotal);
          await sendSbsrDeliveryMethodButtons(from);
          sendReaction(from, messageId, '').catch(() => {});
          return;
        }
        // No summary either — fall through to LLM
        _L('sbsr-interactive', 'ya_lanjut -> no_items_no_summary, falling through');
      }
      if (_btnId === "tidak") {
        _L("sbsr-interactive", "tidak button — letting LLM handle");
        // Fall through to LLM
      }
    }
    // ORDER: IG approval first — pending-state context makes intent unambiguous, and the LLM
    // hallucinates "NO" if it gets the message instead.
    try { sniffMapsLinkFromCustomer(from, userText); } catch (e) { _L("sbsr-maps-sniff", "err: " + e.message); }
    try {
      const _routerDraft = _LD(from) || {};
      let _routerState = sbsrRouterStateLabel(_routerDraft);
      const _trimText = String(userText || "").trim();
      sbsrRouterLogState(_routerState);

      // === GLOBAL QUESTION INTERCEPTOR ===
      // Catches questions in ANY checkout state BEFORE state-specific handlers.
      if (SBSR_OUT_OF_CONTEXT_STATES.has(_routerState) && _trimText.length >= 4) {
        var _qi_isQuestion = /\?/.test(_trimText)
          || /^(?:apa|siapa|kenapa|bagaimana|berapa|kapan|dimana|bisa|boleh|apakah|ada|info|tanya)/i.test(_trimText)
          || /(?:tanya|isi\w*\s+apa|varian\s+apa|rekomendasi|recommend|halal|promo|cara|beda|enak\s+gak|enak\s+nggak|tahan\s+berapa|minimal|min\s+order|best\s+seller|menu\s+apa)/i.test(_trimText)
          || /(?:gak\s*\?|nggak\s*\?|kan\s*\?|ya\s*\?|dong\s*\?)$/i.test(_trimText)
          || /^(?:saya|aku|gue|gw)\s+(?:ingin|mau|butuh|tanya|liat|lihat|cek|tahu)\b/i.test(_trimText)
          || /\b(?:total|semua|list|daftar|rincian|detail|isi\s+pesanan|pesanan\s+saya)\b/i.test(_trimText);
        if (_qi_isQuestion) {
                    _L("sbsr-router", "global_question_intercept state=" + _routerState + " text=" + _trimText.slice(0, 60));
          // === MISSING-FORM GUARD: check before routing to LLM ===
          if (await tryHandleMissingFormInquiry(from, _trimText)) {
            _L("sbsr-router", "global_question_missing_form state=" + _routerState);
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          if (await tryHandleMissingFormClarification(from, _trimText)) {
            _L("sbsr-router", "global_question_missing_form_clarification state=" + _routerState);
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          // === END MISSING-FORM GUARD ===
          if (await tryHandleOocDuringCheckout(from, _trimText, _routerDraft, _routerState)) {
            _L("sbsr-router", "global_question_handled state=" + _routerState);
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          _L("sbsr-router", "global_question_llm_failed state=" + _routerState + " — falling through to normal router");
        }
      }
      // === END GLOBAL QUESTION INTERCEPTOR ===

      // === LLM-FIRST SOPIR: LLM drives ALL checkout conversation ===
      // Deterministic rails become fallback + critical validators only

      // GLOBAL LANJUT INTENT: customer accepts "mau lanjut pesan?" -> transition to next step
      const _acceptLanjut = /^(?:ya|iya|ok|oke|lanjut|siap|deal|boleh|mau|yes|yuk|gas|go)(?:\s+(?:lanjut|pesan|order|aja|deh|dong|kak|ya))*$/i.test(_trimText);
      const _hasItems = (_routerDraft && Array.isArray(_routerDraft.items) && _routerDraft.items.length > 0) || (_routerDraft && _routerDraft.cart && Array.isArray(_routerDraft.cart.items) && _routerDraft.cart.items.length > 0);
      const _hasPendingItems = Array.isArray(_routerDraft?.pending_items) && _routerDraft.pending_items.length > 0;
      const _needsDelivery = !_routerDraft.delivery_mode;
      if (_acceptLanjut && _needsDelivery && (_hasItems || _hasPendingItems)) {
        // If only pending_items (natural reply flow), create real items first
        let _updDraft = _routerDraft;
        if (!_hasItems && _hasPendingItems) {
          const _form = String(_routerDraft.use_case || "").includes("frozen") ? "frozen" : "goreng";
          const _built = buildItemsFromPending(_routerDraft.pending_items, _form);
          _updDraft = { ..._routerDraft, items: _built.items, subtotal: _built.subtotal, pending_items:null, pending_order_summary:null };
          _L("sbsr-lanjut", "created_items_from_pending count=" + _built.items.length + " subtotal=" + _built.subtotal);
        }
        _SD(from, { ..._updDraft, state: "awaiting_delivery_method" });
        await sendSbsrDeliveryMethodButtons(from);
        _L("sbsr-lanjut", "accepted -> delivery_method");
        sbsrRouterLogRail("lanjut-accept");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }

      if (isCheckoutActiveState(_routerState) && _trimText.length >= 2) {
        // Skip states that should ALWAYS be deterministic (no LLM needed)
        const _skipStates = ["awaiting_name", "awaiting_address", "awaiting_pin_confirm", "awaiting_address_pin_confirm"];
        const _isDeterministicOnly = _skipStates.includes(_routerState);
        // Skip structured single-token inputs that deterministic should handle
        const _structuredInput = /^(?:1|2|3|4|ya|iya|tidak|gak|nggak|ok|oke|lanjut|sudah|siap|deal|yes|no|batal|cancel|reset|delivery|pickup)$/i.test(_trimText);
        // Skip maps URLs (deterministic pin handler)
        const _isMapsUrl = /^https?:\/\/.*(?:google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i.test(_trimText);
        // Skip interactive list replies (deterministic variant selection)
        const _isInteractiveReply = _trimText.length <= 3 && /^\d+$/.test(_trimText) && _routerState === "awaiting_product_selection";
      // === ADD-MORE DETECTION: detect "tambah"/"nambah" in any checkout state ===
      if (await tryHandleGlobalAddMore(from, _trimText)) {
        sbsrRouterLogRail("llm-sopir-add-more");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      // === END ADD-MORE DETECTION ===
        if (!_structuredInput && !_isMapsUrl && !_isInteractiveReply && !_isDeterministicOnly) {
          // === MISSING-FORM CLARIFICATION: re-parse after form clarified ===
          if (await tryHandleMissingFormClarification(from, _trimText)) {
            sbsrRouterLogRail("llm-sopir-missing-form-clarification");
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          // === END MISSING-FORM CLARIFICATION ===
          const _sopirHandled = await tryHandleOocDuringCheckout(from, _trimText, _routerDraft, _routerState);
          if (_sopirHandled) {
            sbsrRouterLogRail("llm-sopir");
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
          _L("sbsr-llm-sopir", "llm_failed state=" + _routerState + " — fallthrough to deterministic rails");
        }
      }
      // === END LLM-FIRST SOPIR ===

      // PRIORITY MATRIX: state-locked rails first to prevent cross-rail leakage.
      if (_routerState === "awaiting_question") {
        if (await tryHandleAwaitingQuestionFlow(from, userText)) {
          sbsrRouterLogRail("awaiting_question");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_question");
      }

      if (_routerState === "awaiting_usecase") {
        if (await tryHandlePickupFlow(from, userText)) {
          sbsrRouterLogRail("pickup-intent");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("pickup-intent");
        if (await tryHandleFaq(from, userText)) {
          sbsrRouterLogRail("faq-deterministic");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("faq-deterministic");
        if (await tryHandleUseCaseRouter(from, userText)) {
          sbsrRouterLogRail("awaiting_usecase");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_usecase");
        // Re-check: tryHandleUseCaseRouter may have transitioned state to product_selection
        var _newState = sbsrRouterStateLabel(_LD(from) || {});
        if (_newState === "awaiting_product_selection") {
          _routerState = "awaiting_product_selection";
          _L("sbsr-router", "state_reassigned_to_awaiting_product_selection");
        }
        if (/^\s*[1-4](?:[.)\s].*)?\s*$/i.test(_trimText)) {
          await _M(from, buildSbsrUseCasePromptText());
          sendWhatsAppCata_L(from).catch(function(){});
          sbsrRouterLogRail("awaiting_usecase-reminder");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // Edge case — LLM handle natural language in awaiting_usecase
        setPendingBridgeContext(from, [
          "STATE: awaiting_usecase — customer belum pilih use case.",
          "Customer barusan dikirimin pilihan: 1) makan langsung, 2) stock frozen, 3) meeting/acara, 4) gift/hampers.",
          "Tugas kamu: bantu customer pilih use case sesuai kebutuhan mereka.",
          "JANGAN ngarang harga atau varian produk.",
          "Kalau customer minta menu/katalog, arahkan balas 1 untuk lihat menu.",
          "Kalau customer ngomong di luar konteks, arahkan balik ke 4 pilihan use case.",
        ].join("\n"));
      }

      if (_routerState === "awaiting_addon_reply" || _routerState === "awaiting_addon_signature_clarify") {
        if (await tryHandlePickupFlow(from, userText)) {
          sbsrRouterLogRail("pickup-intent");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("pickup-intent");
        if (await tryHandleFaq(from, userText)) {
          sbsrRouterLogRail("faq-deterministic");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("faq-deterministic");
        if (await tryHandleAddonReply(from, userText)) {
          sbsrRouterLogRail("awaiting_addon_reply");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_addon_reply");
        // Fall through to global interceptors — let OOC/LLM handle instead of canned reminder
        _L("sbsr-addon", "fallthrough_to_global for " + from);
      }

      if (_routerState === "awaiting_delivery_method") {
        if (await tryHandleDeliveryMethodSelection(from, userText)) {
          sbsrRouterLogRail("awaiting_delivery_method");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_delivery_method");
        // Deterministic add-more intercept: "tambah lagi" / "mau nambah" reopen catalog
        const _DM_ADD_MORE_RE = /^(?:mau\s+tambah\s+lagi|tambah\s+lagi|mau\s+tambah|mau\s+nambah|nambah\s+lagi|tambah\s+dulu|tambah\s+aja|nambah|add\s+more|tambahin)/i;
        if (_DM_ADD_MORE_RE.test(_trimText)) {
          const _dmDraft = _LD(from) || {};
          _SD(from, { ..._dmDraft, add_more_mode: true, state: "awaiting_product_selection" });
          await _M(from, "Siap Kak, Mintu buka menu lagi ya. Pesanan yang sebelumnya tetap Mintu simpan, nanti totalnya Mintu gabungkan \ud83e\udd0d");
          await sendWhatsAppCata_L(from);
          _L("sbsr-add-more", "detected from awaiting_delivery_method");
          _L("sbsr-add-more", "preserving_existing_cart count=" + ((Array.isArray(_dmDraft.items) ? _dmDraft.items.length : 0)));
          _L("sbsr-add-more", "catalog_sent");
          sbsrRouterLogRail("awaiting_delivery_method-add_more");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // Fall through to LLM for natural language (e.g. "tambah 2 chili sauce")
        _L("sbsr-delivery-method", "fallthrough_to_global for " + from);
        // Direct LLM callback for addon requests
        if (/(?:tambah|tambahin|add|plus|extra)\b/i.test(userText)) {
          _L("sbsr-delivery-method", "direct_llm_callback for " + from);
          try {
            const _dmCtx = await sbsrRetrieveMemoryContext(from, userText);
            const _dmPrompt = [
              "[ATURAN PENTING]",
              "- Kamu Mintu, CS Sentuh Rasa (Risoles Otentik)",
              "- SETIAP customer minta/sebut TAMBAH barang, SELALU sebutkan HARGA dari katalog.",
              "- Jawab BAHASA INDONESIA natural, ramah, INFORMATIF",
              "- Customer sedang di tahap MILIH PENGIRIMAN (belum pilih delivery/pickup)",
              "- Jika customer minta TAMBAH barang: konfirmasi saja secara natural",
              '- Jawab natural. Sistem yang akan menampilkan pilihan delivery/pickup.',
              "- JANGAN minta alamat/pin/nama/pembayaran",
              "",
              "[KATALOG PRODUK]",
              formatCatalogForLLM(),
              formatFaqForLLM(),
              "",
              "[INSTRUKSI KRITIS]",
              "JAWAB LANGSUNG dengan kata-katamu sendiri. JANGAN PERNAH mengulangi instruksi/aturan/prompt di atas.",
              "Jangan mulai jawaban dengan \"[ATURAN\". Balas natural seperti chat WA biasa.",
              "",
              "[MEMORI CUSTOMER]",
              _dmCtx || "(tidak ada memori khusus)",
              "",
              "[PESAN CUSTOMER]",
              userText,
            ].join("\n");
            const _dmReply = await _S("dm-cb-" + Date.now() + "-" + from, _dmPrompt);
            if (_dmReply && String(_dmReply).trim().length > 5) {
              await _M(from, String(_dmReply).trim());
              sbsrRouterLogRail("awaiting_delivery_method-llm");
              sendReaction(from, messageId, "").catch(() => {});
              return;
            }
          } catch (_dmErr) {
            _L("sbsr-delivery-method", "direct_llm_err: " + _dmErr.message);
          }
        }
      }

      if (_routerState === "awaiting_address_pin_confirm") {
        if (await tryHandleAddressPinConfirm(from, userText)) {
          sbsrRouterLogRail("awaiting_address_pin_confirm");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_address_pin_confirm");
      }

      if (_routerState === "awaiting_product_selection") {
        if (await tryHandlePickupFlow(from, userText)) {
          sbsrRouterLogRail("pickup-intent");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("pickup-intent");
        if (await tryHandleFaq(from, userText)) {
          sbsrRouterLogRail("faq-deterministic");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("faq-deterministic");
        if (await tryHandleCatalogRequest(from, userText)) {
          sbsrRouterLogRail("product-catalog-selection");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (await tryHandleTextVariantSelection(from, userText)) {
          sbsrRouterLogRail("product-text-variant-selection");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }

        if (await tryHandleMissingFormInquiry(from, userText)) {
          sbsrRouterLogRail("product-missing-form-inquiry");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (await tryHandleMissingFormClarification(from, userText)) {
          sbsrRouterLogRail("product-missing-form-clarification");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (await tryHandleFreeTextOrder(from, userText)) {
          sbsrRouterLogRail("product-free-text-selection");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("product-selection");
        if (SBSR_PRODUCT_SELECTION_INTENT_RE.test(_trimText)) {
          _L("sbsr-product-selection", "detected=" + _trimText.slice(0, 80));
          _L("sbsr-product-selection", "waiting_catalog_selection");
          await _M(from, "Siap Kak, pilih dulu produknya dari katalog ya 🤍\nKalau mau *frozen* atau *goreng*, tinggal pilih variannya langsung di katalog.");
          sbsrRouterLogRail("awaiting_product_selection-reminder");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        if (/^\s*[1-9]\d*\s*$/.test(_trimText)) {
          await _M(from, "Kak, sebelum pilih jumlah, pilih dulu varian produknya dari katalog/menu ya 🤍");
          sbsrRouterLogRail("qty-selection-reminder");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        // LLM fallback: unrecognized text in awaiting_product_selection
        // Let Mintu (OpenClaw) answer naturally (e.g. "risoles original" → explains available variants)
        // Fail-open: any error → reminder message unchanged
        let _psLlmHandled = false;
        try {
          const _psFallbackReply = await _S(from, userText);
          if (_psFallbackReply && String(_psFallbackReply).trim()) {
            await _M(from, String(_psFallbackReply).trim());
            sbsrRouterLogRail("awaiting_product_selection-openclaw");
            sendReaction(from, messageId, "").catch(() => {});
            _psLlmHandled = true;
          }
        } catch (_psLlmErr) {
          _L("sbsr-product-selection", "llm_fallback_err=" + _psLlmErr.message);
        }
        if (!_psLlmHandled) {
          await _M(from, "Kak, pilih dulu produknya dari katalog/menu ya. Setelah itu baru lanjut jumlah dan checkout 🤍");
          sbsrRouterLogRail("awaiting_product_selection-reminder");
          sendReaction(from, messageId, "").catch(() => {});
        }
        return;
      }

      if (_routerState === "awaiting_meeting_package_confirm") {
        if (await tryHandleMeetingPackageConfirm(from, userText)) {
          sbsrRouterLogRail("awaiting_meeting_package_confirm");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_meeting_package_confirm");
        // Edge case — LLM handle natural language in awaiting_meeting_package_confirm
        setPendingBridgeContext(from, [
          "STATE: awaiting_meeting_package_confirm — customer ditawarin paket meeting.",
          "Tugas kamu: bantu customer konfirmasi apakah setuju paket meeting atau mau diskusi.",
          "Kalau setuju → suruh balas ya/ok/lanjut.",
          "Kalau nanya detail → jawab natural, JANGAN ngarang harga.",
          "Kalau di luar konteks → arahkan balik ke konfirmasi paket meeting.",
        ].join("\n"));
      }

      if (_routerState === "awaiting_courier_choice") {
        if (await tryHandleFrozenCourierChoice(from, userText)) {
          sbsrRouterLogRail("awaiting_courier_choice");
          sendReaction(from, messageId, "").catch(() => {});
          return;
        }
        sbsrRouterLogSkipped("awaiting_courier_choice");
      }

      if (await tryHandleIgApproval(from, userText)) {
        _L("intercept", "tryHandleIgApproval " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("ig-bridge", "Handled IG APPROVE/CANCEL (priority), skipping LLM");
        return;
      }
      if (await tryHandleSaldo(from, userText)) {
        _L("intercept", "tryHandleSaldo " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("saldo-bridge", "Handled SALDO, skipping LLM");
        return;
      }
      if (await tryHandlePOCreate(from, userText)) {
        _L("intercept", "tryHandlePOCreate " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("po-bridge", "Handled PO CREATE, skipping LLM");
        return;
      }
      if (await tryHandlePOApproval(from, userText)) {
        _L("intercept", "tryHandlePOApproval " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("po-bridge", "Handled PO APPROVE/CANCEL, skipping LLM");
        return;
      }
      if (await tryHandleIgTopicReply(from, userText)) {
        _L("intercept", "tryHandleIgTopicReply " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("ig-bridge", "Handled IG TOPIC REPLY, skipping LLM");
        return;
      }
      if (await tryHandleFrozenCourierChoice(from, userText)) {
        _L("intercept", "tryHandleFrozenCourierChoice " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-courier-choice", "Handled frozen courier choice, skipping LLM");
        return;
      }
      if (await tryHandleOrderConfirm(from, userText)) {
        _L("intercept", "tryHandleOrderConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-parse", "Handled order-confirm (YA/SALAH), skipping LLM");
        return;
      }
      if (await tryHandleCatalogRequest(from, userText)) {
        _L("intercept", "tryHandleCatalogRequest " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-catalog-intercept", "Handled catalog request, skipping LLM");
        return;
      }
      if (await tryHandleMissingFormInquiry(from, userText)) {
        _L("intercept", "tryHandleMissingFormInquiry " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-missing-form", "Handled missing-form inquiry, skipping LLM");
        return;
      }
      if (await tryHandleMissingFormClarification(from, userText)) {
        _L("intercept", "tryHandleMissingFormClarification " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-missing-form", "Handled missing-form clarification, re-parsed");
        return;
      }
      if (await tryHandleFreeTextOrder(from, userText)) {
        _L("intercept", "tryHandleFreeTextOrder " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-parse", "Handled free-text order, skipping LLM");
        return;
      }
      if (await tryHandleCourierOverride(from, userText)) {
        _L("intercept", "tryHandleCourierOverride " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-courier-override", "Handled courier override, skipping LLM");
        return;
      }
      // Deterministic answers for "what URL?" and "where is it being sent?"
      // MUST run before tryHandleOngkirCheck (which historically over-matched
      // on "cek/kirim" tokens). Their guards exclude any message containing a
      // price word OR a Maps URL, so they never collide with quote/cart paths.
      if (await tryHandleUrlEcho(from, userText)) {
        _L("intercept", "tryHandleUrlEcho " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-url-echo", "Handled URL echo, skipping LLM");
        return;
      }
      if (await tryHandleDestinationCheck(from, userText)) {
        _L("intercept", "tryHandleDestinationCheck " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-dest-check", "Handled destination check, skipping LLM");
        return;
      }
      if (await tryHandleOngkirCheck(from, userText)) {
        _L("intercept", "tryHandleOngkirCheck " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-ongkir-check", "Handled ongkir comparison, skipping LLM");
        return;
      }
      if (await tryHandlePickupFlow(from, userText)) {
        _L("intercept", "tryHandlePickupFlow " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-pickup", "Handled pickup flow, skipping LLM");
        return;
      }
      if (await tryHandleUseCaseRouter(from, userText)) {
        _L("intercept", "tryHandleUseCaseRouter " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-usecase", "Handled use-case router, skipping LLM");
        return;
      }
      if (await tryHandlePaymentReviewStatusIntent(from, userText)) {
        _L("intercept", "tryHandlePaymentReviewStatusIntent " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      {
        const _pd = _LD(from) || {};
        const _ps = String(_pd.state || "").trim().toLowerCase();
        if (SBSR_PAYMENT_INFO_RE.test(String(userText || "")) &&
            ["awaiting_proof", "pending_finance", "awaiting_manual_payment_review"].includes(_ps)) {
          const resent = await resendPaymentInstructionFromSource(from);
          if (resent) {
            sendReaction(from, messageId, "").catch(() => {});
            return;
          }
        }
      }
      if (await tryHandleAwaitingNameMultilineEarly(from, userText)) {
        _L("intercept", "tryHandleAwaitingNameMultilineEarly " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleFaq(from, userText)) {
        _L("intercept", "tryHandleFaq " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-faq", "Handled FAQ, skipping LLM");
        return;
      }
      if (await tryHandlePinConfirm(from, userText)) {
        _L("intercept", "tryHandlePinConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-pin-confirm", "Handled pin confirm, skipping LLM");
        return;
      }
      if (await tryHandleWrongInputInLocationStates(from, userText)) {
        _L("intercept", "tryHandleWrongInputInLocationStates " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-wrong-input", "Handled wrong input in location state, skipping LLM");
        return;
      }
      if (await tryHandleAddressPinConfirm(from, userText)) {
        _L("intercept", "tryHandleAddressPinConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleDeliveryMethodSelection(from, userText)) {
        _L("intercept", "tryHandleDeliveryMethodSelection " + from);
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleAddressAndQuote(from, userText)) {
        _L("intercept", "tryHandleAddressAndQuote " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-addr-quote", "Handled address+quote, skipping LLM");
        return;
      }
      if (await tryHandleBareMapsUrl(from, userText)) {
        _L("intercept", "tryHandleBareMapsUrl " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-maps-bare-intercept", "Handled bare maps url, skipping LLM");
        return;
      }
      if (await tryHandleAddonReply(from, userText)) {
        _L("intercept", "tryHandleAddonReply " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-addon", "Handled addon reply, skipping LLM");
        return;
      }
      // Shadow-update customer_name on standalone name reply (returns false → LLM still runs)
      // Shadow-updaters (capture name + address text from standalone msgs; return false → LLM still runs).
      // If both pieces + URL are present after capture, the inner auto-kickoff fires the quote.
      if (await tryHandleNameCapture(from, userText).catch(e => { _L("sbsr-name-capture", "err: " + e.message); return false; })) {
        _L("intercept", "tryHandleNameCapture " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-name-capture", "auto-kickoff fired quote, skipping LLM");
        return;
      }
      if (await tryHandleOutOfContextHandoff(from, userText)) {
        _L("sbsr-router", "blocked_openclaw_global_out_of_context");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      if (await tryHandleAddressTextCapture(from, userText).catch(e => { _L("sbsr-addr-text", "err: " + e.message); return false; })) {
        _L("intercept", "tryHandleAddressTextCapture " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-addr-text", "auto-kickoff fired quote, skipping LLM");
        return;
      }
      if (await tryHandleAdminCmd(from, userText)) {
        _L("intercept", "tryHandleAdminCmd " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-_adm-cmd", "Handled _adm cmd, skipping LLM");
        return;
      }
      if (await tryHandleAdminHandoff(from, userText)) {
        _L("intercept", "tryHandleAdminHandoff " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-_adm-handoff", "Handled _adm handoff, skipping LLM");
        return;
      }
      if (await tryHandleInvoiceOk(from, userText)) {
        _L("intercept", "tryHandleInvoiceOk " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-payment-intercept", "Handled OK->QRIS, skipping LLM");
        return;
      }
      if (await tryHandleAmbiguousConfirm(from, userText)) {
        _L("intercept", "tryHandleAmbiguousConfirm " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("sbsr-ambiguous-confirm", "Handled short ambiguous confirm, skipping LLM");
        return;
      }
      if (await tryHandleIgPost(from, userText)) {
        _L("intercept", "tryHandleIgPost " + from);
        sendReaction(from, messageId, "").catch(() => {});
        _L("ig-bridge", "Handled IG POST, skipping LLM");
        return;
      }
    } catch (e) { _L("bridge-prehandler", "error: " + e.message); }

    const _postDraft = _LD(from) || {};
    const _postState = String(_postDraft.state || "").trim().toLowerCase();
function getStateNudgeText(state) {
  var nudges = {
    "awaiting_usecase": "Silakan pilih kebutuhan: 1) makan langsung, 2) stock frozen, 3) meeting/acara, 4) gift/hampers",
    "awaiting_product_selection": "Silakan pilih varian + jumlah dari katalog ya Kak \u{1f90d}",
    "awaiting_addon_reply": "Kalau sudah cukup, balas LANJUT ya Kak",
    "awaiting_delivery_method": "Pilih pengiriman: 1) Delivery atau 2) Pickup",
    "awaiting_name": "Boleh info nama penerima ya Kak",
    "awaiting_address": "Kirim alamat lengkap + titik Maps ya Kak \u{1f4cd}",
    "awaiting_location": "Share lokasi WhatsApp atau link Google Maps ya Kak",
    "awaiting_address_pin_confirm": "Konfirmasi alamat & pin-nya ya Kak",
    "awaiting_order_confirm": "Balas OK/YA kalau sudah sesuai ya Kak",
    "awaiting_invoice_confirm": "Balas OK/YA untuk lanjut ke pembayaran ya Kak",
    "awaiting_proof": "Upload bukti pembayaran ya Kak \u{1f4f8}",
    "awaiting_pin_confirm": "Konfirmasi pin lokasi ya Kak",
    "awaiting_meeting_package_confirm": "Konfirmasi paket meeting ya Kak",
    "awaiting_courier_choice": "Pilih kurir: 1 atau 2 ya Kak",
    "awaiting_location_retry": "Coba kirim ulang lokasi ya Kak"
  };
  return nudges[state] || "Silakan lanjutkan proses pemesanan ya Kak \u{1f90d}";
}

    const _checkoutLockStates = new Set([
      "awaiting_usecase",
      "awaiting_meeting_package_confirm",
      "awaiting_product_selection",
      "awaiting_addon_reply",
      "awaiting_delivery_method",
      "awaiting_name",
      "awaiting_location",
      "awaiting_address",
      "awaiting_address_pin_confirm",
      "awaiting_pin_confirm",
      "awaiting_order_confirm",
      "awaiting_invoice_confirm",
      "awaiting_location_retry",
    ]);
    if (_checkoutLockStates.has(_postState)) {
      // === SMART OOC: LLM-FIRST -- jawab dulu, baru nudge balik ke state ===
      var _oocHandled2 = false;
      // ADDRESS GUARD: if awaiting_address and text looks like address, skip OOC
      if (_postState === "awaiting_address" && userText.length >= 10 && !/\?/.test(userText)) {
        // Skip OOC - let address text handler process
        _L("sbsr-ooc", "skip_ooc_address_mode");
      } else {
      try {
        var _oocCtx = await sbsrRetrieveMemoryContext(from, userText);
        var _stateNudge = getSbsrDeterministicMissingStateMessage(from, _LD(from) || {}) || "lanjut ke proses pemesanan ya Kak \u{1f90d}";
        var _oocGuard = [
          '[ATURAN PENTING -- KAMU SUPIR, BRIDGE TUJUAN]',
          '- Kamu Mintu, CS Sentuh Rasa (Risoles Otentik) -- ramah, helpful.',
          '- PRIORITAS 1: JAWAB dulu pertanyaan customer dengan lengkap & natural.',
          '- PRIORITAS 2: Setelah menjawab, ingatkan customer: \"' + _stateNudge.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '\"',
          '- SETIAP sebut/minta/tambah produk -> SELALU sebutkan HARGA dari katalog.',
          '- Customer tanya FAQ (halal, lokasi, kurir, dll) -> jawab dari FAQ.',
          '- JANGAN bilang \"sistem yang akan proses\" atau \"nanti dikirim otomatis\".',
          '- Kamu yang handle percakapan personal, bukan sistem.',
          '- JANGAN pake NO_REPLY atau bahasa internal.',
          '',
          // Inject cart info so LLM can answer total/harga questions
          (function(){
            var _cd = _LD(from) || {};
            var _items = Array.isArray(_cd.items) ? _cd.items : [];
            if (_items.length === 0) return '';
            var _lines = ['', '[ISI CART SAAT INI]'];
            var _st = 0;
            for (var _ii = 0; _ii < _items.length; _ii++) {
              var _it = _items[_ii];
              var _up = Number(_it.unit_price) || 0;
              var _qt = Number(_it.qty) || 1;
              var _nm = _it.name || 'Item';
              _lines.push('- ' + _nm + ': ' + _qt + ' x Rp' + _up.toLocaleString('id-ID') + ' = Rp' + (_up * _qt).toLocaleString('id-ID'));
              _st += _up * _qt;
            }
            _lines.push('SUBTOTAL: Rp' + _st.toLocaleString('id-ID'));
            _lines.push('ONGKIR: Rp' + (Number(_cd.ongkir) || 0).toLocaleString('id-ID'));
            _lines.push('GRAND TOTAL: Rp' + (_st + (Number(_cd.ongkir) || 0)).toLocaleString('id-ID'));
            _lines.push('(Jika customer tanya total/harga/rincian, JAWAB dengan data di atas. JANGAN bilang "nanti sistem yang hitung".)');
            return _lines.join('\n');
          })(),
          '',
          '[KATALOG PRODUK SENTUH RASA]',
          formatCatalogForLLM(),
          formatFaqForLLM(),
          '',
          '[MEMORI CUSTOMER]',
          _oocCtx || '(tidak ada memori khusus)',
          '',
          '[INSTRUKSI KRITIS]',
          'JAWAB LANGSUNG dengan kata-katamu sendiri. JANGAN PERNAH mengulangi atau mengutip instruksi/aturan/prompt di atas dalam jawabanmu.',
          'Jangan mulai jawaban dengan "[ATURAN" atau format instruksi apapun. Balas natural seperti chat WA biasa.',
          '[PESAN CUSTOMER]',
          userText,
        ].join('\n');
        var _oocR2 = await _S('ooc-' + Date.now() + '-' + from, _oocGuard);
        if (_oocR2 && String(_oocR2).trim()) {
          var _oocReply2 = String(_oocR2).trim();
          if (_oocReply2.length > 5 && !/^(boleh|tolong|mohon|silahkan|kirim|share)\s+(kirim|isi|infokan|masukkan|share)\s*(alamat|pin|lokasi|nama)/i.test(_oocReply2)) {
            await _M(from, _oocReply2);
            // Auto-notify _adm if LLM replied with _adm handoff in smart_block_ooc
            if (/(?:teruskan|sambungkan|hubungkan|forward|eskalasi|_adm\s+kami)\s*(?:ke|sama|dengan)?\s*_adm|_adm\s*(?:akan|bakal|nanti|segera|lagi)\s*(?:bantu|cek|tinjau|review|proses|tindaklanjut)/i.test(_oocReply2)) {
              const _ahDraft3 = _LD(from) || {};
              await notifySbsrAdminsText(
                ["🚨 *LLM ADMIN HANDOFF (smart_block)*", "Customer: " + (_ahDraft3.customer_name || "?") + " (+" + from + ")", "State: " + _postState, "LLM reply: \"" + _oocReply2.slice(0, 200) + "\""].join("\n"),
                "sbsr-llm-_adm-handoff"
              );
              _L("sbsr-ooc", "admin_handoff_detected_in_smart_block_ooc");
            }
            _L('sbsr-ooc', 'smart_block_ooc state=' + _postState + ' reply=' + _oocReply2.slice(0, 100));
            // Auto-send interactive buttons if LLM asks "mau lanjut?"
            if (/mau\s+langsung\s+pesan|lanjut\s+ke\s+alamat|mau\s+lanjut\s+pesan/i.test(_oocReply2)) {
              try {
                await sendWhatsAppInteractiveButtons(from,
                  "Pilih opsi di bawah ya Kak \u{1f90d}",
                  [
                    { type: "reply", reply: { id: "ya_lanjut", title: "Ya, lanjut pesan" } },
                    { type: "reply", reply: { id: "tidak", title: "Tidak dulu" } }
                  ]
                );
                _L('sbsr-interactive', 'lanjut_buttons_sent');
              } catch (_ibErr) {
                _L('sbsr-interactive', 'button_err: ' + (_ibErr && _ibErr.message));
              }
            }
            _oocHandled2 = true;
          }
        }
      } catch (_e2) {
        _L('sbsr-ooc', 'smart_block_err: ' + _e2.message);
      }
      if (_oocHandled2) {
        _L("sbsr-router", "ooc_handled_by_llm");
        sendReaction(from, messageId, "").catch(() => {});
        return;
      }
      _L("sbsr-router", "blocked_openclaw_checkout");
      const _fallback = getSbsrDeterministicMissingStateMessage(from, _postDraft);
      try { await _M(from, _fallback); } catch (_) {}
      return;
    }
    } // close address guard else

    // Hydrate LLM with state from prior bridge-handled turns. Without this,
    // the LLM repeats steps that interceptors already executed (re-asking for
    // nama/alamat/maps after addr+quote intercept, fabricating invoices when
    // sentuh-quote.mjs failed and we fell through, etc).
    // Deterministic reply for total/detail questions in awaiting_proof/pending_finance
    const _preLlmDraft = _LD(from) || {};
    const _preLlmState = String(_preLlmDraft.state || "").trim().toLowerCase();
    if ((_preLlmState === "awaiting_proof" || _preLlmState === "pending_finance") &&
        /(?:total|detail|invoice|rincian|pesanan\s+saya|isi\s+pesanan|list|daftar|semua)/i.test(userText)) {
      await _M(from, "Siap Kak. Nanti sistem yang akan kirim detail total pesanan dan invoice pembayarannya ya \ud83e\udd0d");
      _L("sbsr-ooc", "deterministic_total_reply for " + from + " state=" + _preLlmState);
      sendReaction(from, null, "").catch(() => {});
      return;
    }
    // Terminal state context — inject order status for LLM to avoid hallucination
    const _termStates = ["payment_verified_manual","payment_rejected_manual","booked","approved","payment_verified","payment_rejected"];
    if (_termStates.includes(_preLlmState)) {
      const _termLabels = {
        "payment_verified_manual": "Pembayaran SUDAH DIVERIFIKASI — order selesai.",
        "payment_rejected_manual": "Pembayaran DITOLAK — customer bisa upload ulang.",
        "booked": "Order SUDAH DIBOOKING — sedang diproses.",
        "approved": "Order DISETUJUI _adm.",
        "payment_verified": "Pembayaran SUDAH DIVERIFIKASI — order selesai.",
        "payment_rejected": "Pembayaran DITOLAK _adm.",
      };
      setPendingBridgeContext(from, [
        "STATE: " + _preLlmState + " — " + (_termLabels[_preLlmState] || "Order dalam proses."),
        "JANGAN minta alamat/nama/pin/pembayaran — order sedang/post-order.",
        "JANGAN ulang flow checkout atau minta bayar lagi.",
        "Kalau customer nanya status → jelasin status order saat ini.",
        "Kalau customer minta order baru → bantu dengan menu/katalog baru.",
        "Kalau customer komplain → catat dan informasikan akan diteruskan ke _adm.",
        "JANGAN ngarang harga, produk, atau janji pengiriman.",
      ].join("\n"));
    }
    let llmText = userText;
    // Admin pause: skip LLM reply when operator has manually taken over this chat.
    // Bridge interceptors above (orders, catalog, _adm cmds) already executed.
    if (_adm.isPaused(from)) { _L("_adm", "bot paused for " + from + " — skipping AI reply"); return; }

    // === BIKS COST-GUARD: pre-flight ===
    // Bridge can't see token usage, so we count requests at PER_REQUEST_COST_ESTIMATE_USD
    // each. Daily cap default $5 ≈ 1000 reqs/day — runaway loop trips it long
    // before OpenRouter-side billing surprises. Admin numbers bypass.
    if (_sec && _sec.costGuard && !_isAdminPhoneSec(from)) {
      try {
        if (!_sec.costGuard.canSpend(PER_REQUEST_COST_ESTIMATE_USD)) {
          const _t = _sec.costGuard.today();
          _L("cost-guard", "DAILY CAP HIT spend=$" + Number(_t.spend_usd).toFixed(4) + " cap=$" + _sec.costGuard.dailyCapUsd + " phone=" + from);
          await _M(from, "Mintu lagi sibuk banget hari ini, balas lagi besok pagi ya 🙏").catch(() => {});
          return;
        }
      } catch (e) { _L("cost-guard", "err — failing open: " + e.message); }
    }
    // === END BIKS COST-GUARD pre-flight ===

    const t0 = Date.now();
    let aiReply;
    try { aiReply = await enqueueMessage(from, llmText); }
    catch (err) {
      _L("openclaw", "Error: " + err.message);
      if (!gatewayReady) connectGateway();
      // Suppress duplicate generic-error ONLY for orphan-call timeouts where a parallel
      // inbound from the same customer already received a successful reply AFTER this
      // call started. Pattern: 3 rapid inbounds → 1 LLM call replies fast covering the
      // intent → other LLM calls orphaned → time out 240s later → would re-message a
      // customer who already got their answer.
      // Precise check: t0 is when this call started; if last_reply_at > t0, a concurrent
      // reply already went out → safe to suppress without losing real errors for
      // genuinely-stuck single-message conversations.
      if (err.message === "OpenClaw response timeout") {
        try {
          const _dr = _LD(from);
          const _last = _dr?.last_reply_at ? new Date(_dr.last_reply_at).getTime() : 0;
          if (_last > t0) {
            _L("openclaw-timeout-suppressed", "for " + from + " — concurrent reply at " + _dr.last_reply_at + " (after t0=" + new Date(t0).toISOString() + ")");
            return;
          }
        } catch (_) {}
      }
      aiReply = "Maaf, ada error. Coba lagi ya.";
    }
    _L("timing", "OpenClaw response: " + (Date.now() - t0) + "ms");
    // === BIKS COST-GUARD: record (after every LLM round-trip, success or fallback) ===
    if (_sec && _sec.costGuard) {
      try {
        _sec.costGuard.record({ kind: "chat", model: "unknown", costUsd: PER_REQUEST_COST_ESTIMATE_USD });
        const _t = _sec.costGuard.today();
        if (Number(_t.spend_usd) >= _sec.costGuard.softCapUsd) {
          _L("cost-guard", "soft-cap reached: spend=$" + Number(_t.spend_usd).toFixed(4) + " soft=$" + _sec.costGuard.softCapUsd + " hard=$" + _sec.costGuard.dailyCapUsd + " reqs=" + _t.requests);
        }
      } catch (e) { _L("cost-guard", "record err: " + e.message); }
    }
    try { sniffInvoiceFromAiReply(from, aiReply); } catch (e) { _L("sbsr-sniff", "err: " + e.message); }
    try { sniffCartAckFromAiReply(from, aiReply); } catch (e) { _L("sbsr-cart-sniff", "err: " + e.message); }
    try { if (await maybeAutoQuote(from, aiReply)) { _L("sbsr-auto-quote", "fired post-LLM, suppressing duplicate reply"); return; } } catch (e) { _L("sbsr-auto-quote", "err: " + e.message); }
    try { aiReply = enrichInvoiceWithMaps(from, aiReply); } catch (e) { _L("sbsr-maps-inject", "err: " + e.message); }
    try { await maybeFireAdminEscalation(from, contactName, userText, aiReply); } catch (e) { _L("sbsr-escalate", "err: " + e.message); }
    if (shouldBlockSbsrCheckoutEnglishReply(from, aiReply)) {
      _L("sbsr-checkout-guard", "blocked English checkout reply; using deterministic fallback");
      aiReply = getSbsrCheckoutEnglishFallback(from);
    }
    const _replyDraft = _LD(from) || {};
    const _replyState = String(_replyDraft.state || "").trim().toLowerCase();
    if (["awaiting_usecase","awaiting_meeting_package_confirm","awaiting_product_selection","awaiting_addon_reply","awaiting_delivery_method","awaiting_name","awaiting_location","awaiting_address","awaiting_address_pin_confirm","awaiting_pin_confirm","awaiting_order_confirm","awaiting_invoice_confirm"].includes(_replyState) &&
        shouldBlockOpenClawCheckoutLeak(aiReply)) {
      _L("sbsr-router", "blocked_openclaw_checkout");
      aiReply = getSbsrDeterministicMissingStateMessage(from, _replyDraft);
    }

    try {
      await sbsrStoreExtractedMemories(from, userText, aiReply, _LD(from) || {});
    } catch (e) { _L("sbsr-memory", "store pipeline err: " + e.message); }

    if (!aiReply || !aiReply.trim()) { _L("warn", "Empty response from OpenClaw, skipping WA send"); sendReaction(from, messageId, "").catch(() => {}); return; }

    // Junk-reply filter — Codex sometimes hallucinates a bare "NO" / "YES" / "OK" when a tool was called
    // alongside text generation. These are always wrong (the user never benefits from a one-word reply
    // when they didn't ask a yes/no question). Drop them before they reach WA.
    const trimmedReply = aiReply.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (/^(no|yes|ya|ok|oke|nope|yep|sure)[.!]?$/i.test(trimmedReply)) {
      _L("junk-filter", "Suppressed hallucinated one-word reply: " + JSON.stringify(trimmedReply));
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }

    const qrisDraft = _LD(from) || {};
    const qrisHandled = await maybeSendQrisMarkerMedia(from, aiReply, qrisDraft.grand_total || qrisDraft.expected_total || 0);
    aiReply = qrisHandled.text || "";
    if (!aiReply.trim()) {
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }

    // Check if response contains [MENU] marker — send interactive list
    const cleanReply = aiReply.replace(/```[\s\S]*?```/g, m => m.replace(/`/g, "")).trim();
    _L("raw-reply", "RAW[" + aiReply.length + "]: " + JSON.stringify(aiReply.substring(0,300)));
    if (/\[CATALOG/.test(cleanReply) || /\[CATALOG/.test(aiReply)) {
      try {
        await sendWhatsAppCata_L(from);
        _L("reply", "To " + from + ": [CATALOG sent]");
      } catch (catErr) {
        _L("wa-catalog", "Catalog failed, deterministic text fallback: " + catErr.message);
        await sendCatalogDeterministicFallback(from, catErr.message);
      }
      sendReaction(from, messageId, "").catch(() => {});
      return;
    }
    if (/\[MENU/.test(cleanReply) || /\[MENU/.test(aiReply)) {
      try {
        await sendWhatsAppInteractiveList(from);
        // Do NOT send any trailing text when [MENU] detected — user only sees the clean dropdown
      } catch (menuErr) {
        _L("wa-menu", "Interactive list failed, falling back to text: " + menuErr.message);
        // Fallback: send as plain text menu
        const fallbackMenu = "Halo! Gw Airo, bot _adm Airoklin. Pilih yang mau lo kerjain:\n\n1. Catat Expense — Catat pengeluaran ke dashboard\n2. Catat Revenue — Catat pemasukan ke dashboard\n3. Bayar Tukang/Jasa (FPD) — Reimbursement / Overhead / Kasbon\n4. Tagihan Client (Invoice) — Bill client + simpan PDF ke Drive\n5. Post di Instagram — Bikin poster + post ke IG\n\nKetik angka 1-5 atau langsung bilang apa yang mau lo kerjain.";
        await _M(from, fallbackMenu);
      }
    } else {
      const parts = splitMessage(aiReply);
      for (const part of parts) { if (part && part.trim()) await _M(from, part); }
    }
    sendReaction(from, messageId, "").catch(() => {});
    _L("reply", "To " + from + ": " + aiReply.substring(0, 100) + "...");
}
module.exports={init,processMessage:_processMessage};
