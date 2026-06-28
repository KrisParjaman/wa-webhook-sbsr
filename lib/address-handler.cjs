// address-handler.cjs — Address & quote handler.
// Extracted from server.js (660 lines). Heavy DI.

'use strict';

const am = require('./address-matcher.cjs');
const mg = require('./maps-geocode.cjs');

let _sendToOpenClaw, _sendMessage, _log, _loadDraft, _saveDraft;

function init(opts) {
  _sendToOpenClaw = opts.sendToOpenClaw;
  _sendMessage = opts.sendMessage;
  _log = opts.log;
  _loadDraft = opts.loadDraft;
  _saveDraft = opts.saveDraft;
}

async function tryHandleAddressAndQuote(from, userText) {
  if (!userText) return false;
  // Note: we DO NOT exclude admin here — operator routinely tests as customer
  // from the admin number. The other gates (items + customer_name in draft) are enough.
  const draft = _loadDraft(from);
  if (!draft) return false;
  if (!Array.isArray(draft.items) || draft.items.length === 0) return false;
  // Safety net: if no delivery_mode set but message has maps URL/coords, auto-set to delivery
  if (!draft.delivery_mode || String(draft.state || "").trim().toLowerCase() === "awaiting_delivery_method") {
    const _hasMapsUrl = MAPS_URL_RE.test(String(userText || ""));
    const _hasSavedCoords = Number.isFinite(Number(draft.destination?.lat)) && Number.isFinite(Number(draft.destination?.lng));
    if (!draft.delivery_mode && (_hasMapsUrl || _hasSavedCoords || draft.gmaps_link)) {
      _saveDraft(from, { ...draft, delivery_mode: "delivery", delivery_mode_set_at: new Date().toISOString() });
      _log("sbsr-delivery-mode", "auto-set delivery from maps/coords for " + from);
    } else {
      if (/^(?:1|2|delivery|dikirim|kirim|antar|pickup|ambil\s*sendiri|ambil|mampir)$/i.test(String(userText).trim())) {
        _saveDraft(from, { ...draft, state: "awaiting_delivery_method" });
        await _sendMessage(from, buildSbsrDeliveryMethodPromptText());
        _log("sbsr-delivery-method", "prompt_sent");
        return true;
      }
      _log("sbsr-delivery-method", "addr_quote_fallthrough_to_global for " + from);
      return false;
    }
  }
  const um = userText.match(MAPS_URL_RE);
  const hasMapsHint = MAPS_HINT_RE.test(String(userText || ""));
  const savedDest = draft.destination || {};
  const hasSavedCoords = Number.isFinite(Number(savedDest.lat)) && Number.isFinite(Number(savedDest.lng));
  const hasSavedPostal = !!savedDest.postal_code;
  if (!um && !hasSavedCoords && !hasSavedPostal && !hasMapsHint) return false;
  // If draft has no customer_name yet, try to pull it from this message:
  //   "Nama\nJohn Biks" / "Nama: John Biks" / "atas nama John Biks"
  if (!draft.customer_name) {
    // 1) Try name in current message ("Saya X" / "Aku X" / "Nama saya X" / "Atas nama X" / standalone)
    let extracted = (typeof extractCustomerName === "function") ? extractCustomerName(userText) : null;
    let nameSource = "current-msg";
    // 2) Fallback: scan recent inbound chat history (rescues customers who gave the name
    //    earlier in the conversation but the bridge missed it — e.g. before deploy).
    if (!extracted) {
      extracted = findNameInChatHistory(from);
      if (extracted) nameSource = "chat-history";
    }
    if (extracted) {
      draft.customer_name = extracted;
      draft.customer_name_set_at = new Date().toISOString();
      _log("sbsr-addr-quote", `extracted customer_name (${nameSource}): ${draft.customer_name}`);
    } else {
      // No name anywhere — break the silent stall by asking deterministically.
      // Save the URL to draft so the next inbound (the name) can resume the quote.
      const url = um ? um[1] : (draft.gmaps_link || (draft.destination && draft.destination.gmaps_link) || null);
      _saveDraft(from, { ...draft, ...(url ? { gmaps_link: url, gmaps_link_seen_at: new Date().toISOString() } : {}) });
      try {
        await _sendMessage(from,
          "Lokasinya sudah Mintu terima 🤍\n\n" +
          "Boleh info atas nama siapa Kak? Biar Mintu lanjut cek ongkir + ekspedisinya."
        );
      } catch (e) { _log("sbsr-addr-quote", "name-prompt send err: " + e.message); }
      setPendingBridgeContext(from, [
        "Bridge sudah terima maps URL + simpan ke draft, dan minta nama customer.",
        "STATE: draft punya items + gmaps_link, tapi belum ada customer_name.",
        "JANGAN tanya alamat / pin lagi — sudah disimpan.",
        "Tunggu customer kirim nama → bridge name-capture akan fire-trigger quote otomatis.",
      ].join("\n"));
      _log("sbsr-addr-quote", "from=" + from + " no name anywhere, sent name prompt + saved URL");
      return true;
    }
  }
  // Skip if already at/past invoice
  if (["awaiting_invoice_confirm", "awaiting_proof", "pending_finance", "approved", "booked", "delivered", "cancelled"].includes(draft.state)) return false;

  const url = um ? um[1] : (draft.gmaps_link || savedDest.gmaps_link || null);
  let resolved = null;
  if (um) {
    resolved = await resolveGmapsUrlBridge(url).catch(() => null);
    _log("sbsr-location", "source=" + (/maps\.app\.goo\.gl/i.test(url) ? "maps_app" : "gmaps_link"));
  } else if (hasSavedCoords) {
    resolved = { lat: Number(savedDest.lat), lng: Number(savedDest.lng) };
    _log("sbsr-location", "source=gmaps_preview");
  } else if (hasSavedPostal) {
    resolved = { postal_code: savedDest.postal_code };
  } else if (hasMapsHint) {
    const direct = parseDirectGmapsCoordsBridge(userText) || extractCoordsFromMapsUrlBridge(userText);
    if (direct) {
      resolved = direct;
      _log("sbsr-location", "source=gmaps_preview");
      _log("gmaps-resolve", "extracted_coordinates");
    }
  }
  const unresolvedMeta = (resolved && resolved.unresolved) ? resolved : null;
  if (!resolved || unresolvedMeta) {
    const decodedPlace = unresolvedMeta?.decoded_place || decodeMapsPlaceFromUrlBridge(unresolvedMeta?.final_url || url || "");
    const fromMsgCandidate = String(userText || "").replace(MAPS_URL_RE, "").trim().replace(/\s+/g, " ");
    const savedAddrCandidate = pickNonEmpty(
      draft.address_text,
      (draft.destination && draft.destination.address_text && !draft.destination.address_text.startsWith("(")) ? draft.destination.address_text : "",
      ""
    );
    const addressTextCandidate = fromMsgCandidate || draft.pending_address_text || savedAddrCandidate || "";
    const hasConflict = await hasSemanticRegionConflict(addressTextCandidate, decodedPlace);
    const hasMismatch = await hasTextOnlyDistrictMismatch(addressTextCandidate, decodedPlace);
    if (decodedPlace && addressTextCandidate && (hasConflict || hasMismatch)) {
      _saveDraft(from, {
        ...draft,
        state: "awaiting_address_pin_confirm",
        pending_decoded_place: decodedPlace,
        pending_maps_url: unresolvedMeta?.original_url || url || "",
        address_pin_confirm: {
          mode: "semantic_place_conflict",
          address_text: addressTextCandidate,
          decoded_place: decodedPlace,
          gmaps_link: unresolvedMeta?.original_url || url || "",
        },
      });
      _log("sbsr-address-pin-check", "decoded_place_text_only_compare");
      _log("sbsr-address-pin-check", "semantic_mismatch_detected");
      _log("sbsr-address-pin-check", "confidence=low");
      _log("sbsr-address-pin-check", "decoded_place=" + decodedPlace);
      _log("sbsr-address-pin-check", "quote_blocked_pending_confirmation");
      _log("sbsr-maps-sniff", "handled_semantic_mismatch");
      try {
        await _sendMessage(
          from,
          "Alamat tertulis dan titik Maps-nya terlihat berbeda ya Kak 🤍\n\n" +
          `Alamat tertulis:\n${addressTextCandidate}\n\n` +
          `Titik Maps yang Kakak kirim:\n${decodedPlace}\n\n` +
          "Yang benar dipakai yang mana?\n" +
          "1. Pakai alamat tertulis\n" +
          "2. Kirim ulang titik Maps\n" +
          "3. Sambungkan ke admin"
        );
      } catch (e) { _log("sbsr-addr-quote", "semantic mismatch prompt err: " + e.message); }
      return true;
    }
    // For maps.app / gmaps links with decoded place that semantically matches typed address,
    // retry deterministic geocode before generic unreadable fallback.
    const hasSemanticMatch = !!(
      decodedPlace && addressTextCandidate &&
      !(await hasSemanticRegionConflict(addressTextCandidate, decodedPlace)) &&
      (
        (hasJakartaHint(decodedPlace) && hasJakartaHint(addressTextCandidate)) ||
        ((await extractSemanticRegion(decodedPlace)) && (await extractSemanticRegion(decodedPlace)) === (await extractSemanticRegion(addressTextCandidate)))
      )
    );
    if (hasSemanticMatch) {
      const geoDecoded = await geocodeAddressTextBridge(decodedPlace);
      const geo = geoDecoded;
      if (geo) {
        resolved = {
          lat: Number(geo.lat),
          lng: Number(geo.lng),
          address_text: addressTextCandidate || decodedPlace,
          source: /maps\.app\.goo\.gl/i.test(url || "") ? "maps_app" : "gmaps_link",
        };
        _log("gmaps-geocode", `accepted lat=${resolved.lat} lng=${resolved.lng}`);
        _log("gmaps-resolve", "resolved via decoded_place_geocode");
      }
    }
    if (resolved && Number.isFinite(Number(resolved.lat)) && Number.isFinite(Number(resolved.lng))) {
      // continue deterministic quote flow with recovered coords
    } else {
    _log("sbsr-addr-quote", "from=" + from + " url failed to resolve");
    const fails = (Number(draft.location_resolve_fails) || 0) + 1;
    _saveDraft(from, {
      ...draft,
      location_resolve_fails: fails,
      location_resolve_failed_at: new Date().toISOString(),
      last_failed_url: url,
    });
    _log("sbsr-addr-quote", `from=${from} resolve-fail count=${fails}`);
    _log("gmaps-recover", "unresolved_soft_fail");
    // BUG#3 fix: set awaiting_location_retry + user-facing recovery options (no admin handoff)
    const _rDraft = _loadDraft(from) || draft;
    _saveDraft(from, { ..._rDraft, state: "awaiting_location_retry" });
    try {
      await sendWhatsAppLocationRequest(from,
        "Kak, titik Maps tadi belum bisa kebaca sistem 🙏\n" +
        "Boleh coba tap tombol *Send Location* di bawah buat share lokasi langsung dari WhatsApp, atau kirim ulang link Google Maps ya"
      );
    } catch (e) { _log("sbsr-addr-quote", "maps-retry-prompt err: " + e.message); }
    return true;
    }
  }
  // URL resolved successfully — reset failure counter
  if (draft.location_resolve_fails) {
    _saveDraft(from, { ...draft, location_resolve_fails: 0, location_admin_notified_at: null });
    _log("sbsr-addr-quote", "reset resolve-fail counter for " + from);
  }
  // Address text fallback chain (in order):
  //   1. fresh text in this message minus the URL
  //   2. earlier captured pending_address_text
  //   3. previously-saved destination.address_text — preserves typed address across
  //      the YA-confirm re-fire from tryHandlePinConfirm (which passes only the URL,
  //      so fromMsg=="" and pending_address_text was already cleared on first save).
  //      Without this fallback, the second invocation showed "(alamat dari pin)" on
  //      the invoice even though the customer had typed a real address.
  //   4. ultimate placeholder
  const fromMsg = userText.replace(MAPS_URL_RE, "").trim().replace(/\s+/g, " ");
  const savedAddrText = pickNonEmpty(
    draft.address_text,
    (draft.destination && draft.destination.address_text && !draft.destination.address_text.startsWith("(")) ? draft.destination.address_text : "",
    ""
  );
  const addressText = fromMsg || draft.pending_address_text || savedAddrText || resolved.address_text || "(alamat dari lokasi WA)";
  if (!fromMsg && draft.pending_address_text) {
    _log("sbsr-addr-quote", "using pending_address_text from earlier message: " + draft.pending_address_text.slice(0, 60));
  } else if (!fromMsg && !draft.pending_address_text && savedAddrText) {
    _log("sbsr-addr-quote", "using saved destination.address_text from prior call: " + savedAddrText.slice(0, 60));
  }

  // Build destination FROM SCRATCH for this pin — do NOT spread the old
  // draft.destination, which previously caused stale lat/lng/postal_code/address_text
  // from a prior incomplete order to leak into the new quote (and into LLM context,
  // where they were echoed back to the customer as if they had been received).
  // Fresh pin = fresh destination.
  const destBase = {
    ...(um ? {} : (draft.destination || {})),
    address_text: addressText,
  };
  if (url) destBase.gmaps_link = url;
  if (resolved.lat !== undefined && resolved.lng !== undefined) {
    destBase.lat = resolved.lat;
    destBase.lng = resolved.lng;
    destBase.source = um ? (/maps\.app\.goo\.gl/i.test(url) ? "maps_app" : "gmaps_link") : "gmaps_preview";
  } else if (resolved.postal_code) {
    destBase.postal_code = resolved.postal_code;
    destBase.source = "gmaps_link";
  }
  _log("sbsr-addr-quote", "resolved destination for " + from + " via " + (resolved.lat ? "coords" : "postal=" + resolved.postal_code));
  if (url) {
    _log("sbsr-maps-sniff", "resolved via google_maps_link");
  }
  const decodedPlace = String(resolved?.decoded_place || (url ? decodeMapsPlaceFromUrlBridge(url) : '') || '').trim();
  const displayLoc = await resolveLocationDisplayBridge({
    decodedPlace: decodedPlace || resolved.address_text || "",
    lat: destBase.lat,
    lng: destBase.lng,
    gmapsLink: url || destBase.gmaps_link || "",
  });
  destBase.place_address = displayLoc.place_address || "";
  destBase.place_label = displayLoc.place_label || "";
  let resolvedConfidence = String(resolved?.confidence || "high").toLowerCase();
  const DISTANCE_THRESHOLD_KM = 3.0;
  let addressPinValidationPassed = false;
  // typedGeo-crash-fix: hoisted so outer LLM/semantic checks can reference them safely
  let typedGeo = null;
  let distKm = null;
  let sameStreetMatch = false;
  let sameKecamatan = false;
  if (Number.isFinite(Number(destBase.lat)) && Number.isFinite(Number(destBase.lng))) {
    const typedDistrict = extractDistrictFromText(addressText);
    const pinRev = await reverseGeocodeCoordsBridge(Number(destBase.lat), Number(destBase.lng));
    const pinDistrict = extractDistrictFromText(
      `${pinRev?.district || ""} ${pinRev?.city || ""} ${pinRev?.county || ""} ${pinRev?.display || ""}`
    );
    const typedGeo = await geocodeTypedAddressWithFallback(addressText);
    let distKm = null;
    const addrL = String(addressText || "").toLowerCase();
    const pinL = String(
      decodedPlace ||
      resolved.address_text ||
      destBase.place_address ||
      destBase.place_label ||
      pinRev?.display ||
      ''
    ).toLowerCase();
    const sameStreetMatch = /nusa\s+indah\s+raya/.test(addrL) && /nusa\s+indah\s+raya/.test(pinL);
    const sameKelurahan = /cipinang\s*muara/.test(addrL) && /cipinang\s*muara/.test(pinL);
    const sameKecamatan = /jatinegara/.test(addrL) && /jatinegara/.test(pinL);
    const sameAreaStrong = sameStreetMatch && sameKelurahan && sameKecamatan;
    _log("sbsr-address-pin-check", "same_street_match=" + String(sameStreetMatch));
    _log("sbsr-address-pin-check", "same_kelurahan=" + String(sameKelurahan));
    _log("sbsr-address-pin-check", "same_kecamatan=" + String(sameKecamatan));
    if (typedGeo) {
      _log("sbsr-address-pin-check", "typed_lat=" + Number(typedGeo.lat).toFixed(6));
      _log("sbsr-address-pin-check", "typed_lng=" + Number(typedGeo.lng).toFixed(6));
    }
    _log("sbsr-address-pin-check", "pin_lat=" + Number(destBase.lat).toFixed(6));
    _log("sbsr-address-pin-check", "pin_lng=" + Number(destBase.lng).toFixed(6));
    _log("sbsr-address-pin-check", "threshold_km=1");
    if (typedGeo) {
      distKm = haversineKm(typedGeo.lat, typedGeo.lng, Number(destBase.lat), Number(destBase.lng));
      _log("sbsr-address-pin-check", "distance_km=" + distKm.toFixed(1));
    }
    if (typedDistrict) _log("sbsr-address-pin-check", "typed_district=" + typedDistrict);
    if (pinDistrict) _log("sbsr-address-pin-check", "pin_district=" + pinDistrict);
    const typedRegion = (await extractSemanticRegion(addressText)) || "";
    const pinRegion = (await extractSemanticRegion(pinRev?.display || pinRev?.city || pinRev?.state || "")) || "";
    const districtMismatch = !!(typedDistrict && pinDistrict && typedDistrict !== pinDistrict);
    const regionMismatch = !!(typedRegion && pinRegion && typedRegion !== pinRegion);
    const distanceExceeded = Number.isFinite(distKm) && distKm > DISTANCE_THRESHOLD_KM;
    if (distanceExceeded) _log("sbsr-address-pin-check", "distance_threshold_exceeded");
    if (sameAreaStrong) {
      resolvedConfidence = "high";
    } else if (regionMismatch || districtMismatch || distanceExceeded) {
      resolvedConfidence = "low";
    } else if ((typedDistrict && pinDistrict && typedDistrict === pinDistrict) || (Number.isFinite(distKm) && distKm <= DISTANCE_THRESHOLD_KM)) {
      resolvedConfidence = "high";
    } else if (!typedGeo && sameAreaStrong) {
      resolvedConfidence = "high";
    } else if (!typedGeo && typedRegion && pinRegion && typedRegion === pinRegion) {
      resolvedConfidence = "medium";
    } else if (!typedGeo && sameKecamatan && addressText && addressText.length > 20 && /\b(jl|jln|jalan|blok|gang|gg|rt|rw)\b/i.test(addressText)) {
      // AND same kecamatan matches Maps pin. Accept as high confidence.
      resolvedConfidence = "high";
    } else {
      resolvedConfidence = "low";
    }
    if (resolvedConfidence === "high") {
      addressPinValidationPassed = true;
      _log("sbsr-address-pin-check", "validation_passed");
    }
    // Fallback: if typed address has street keywords + same kecamatan as Maps pin
    if (resolvedConfidence === "low" && addressText && destBase && (destBase.place_label || destBase.place_address)) {
      var _falAddr = String(addressText).toLowerCase();
      var _falPin = String(destBase.place_label || destBase.place_address || "").toLowerCase();
      var _falKec = /jatinegara/.test(_falAddr) && /jatinegara/.test(_falPin);
      var _falJln = /\b(jl|jln|jalan|blok|gang|gg|rt|rw)\b/i.test(_falAddr);
      if (_falKec && _falJln && _falAddr.length > 20) {
        resolvedConfidence = "high";
        addressPinValidationPassed = true;
        _log("sbsr-address-pin-check", "accepted_via_kecamatan_fallback");
      }
    }
  }
  // semanticAddressMatch: broader LLM validator — triggers on any uncertain/failed deterministic match.
  // Conditions: !addressPinValidationPassed AND resolvedConfidence !== "high"
  // Fail-open: any error → null → existing resolvedConfidence unchanged (deterministic behavior).
  if (!addressPinValidationPassed && resolvedConfidence !== "high") {
    const _semMapsAddr = String(decodedPlace || destBase.place_label || destBase.place_address || "").trim();
    if (_semMapsAddr && addressText) {
      _log("sbsr-address-semantic", "triggered");
      _log("sbsr-address-semantic", "typed=" + String(addressText).slice(0, 80));
      _log("sbsr-address-semantic", "resolved=" + _semMapsAddr.slice(0, 80));
      const _semResult = await semanticAddressMatch({
        typedAddress: addressText,
        resolvedMapsAddress: _semMapsAddr,
      }).catch(function(e) { _log("sbsr-address-semantic", "error=" + e.message); return null; });
      if (_semResult) {
        _log("sbsr-address-semantic", "llm_match=" + String(_semResult.match));
        _log("sbsr-address-semantic", "confidence=" + _semResult.confidence);
        _log("sbsr-address-semantic", "reason=" + _semResult.reason);
        if (_semResult.match === true && (_semResult.confidence === "high" || _semResult.confidence === "medium")) {
          if (_semResult.confidence === "high") {
            resolvedConfidence = "high";
            addressPinValidationPassed = true;
          } else {
            if (resolvedConfidence === "low") resolvedConfidence = "medium";
          }
          _log("sbsr-address-semantic", "fallback_continue_checkout");
        } else {
          _log("sbsr-address-semantic", "mismatch_confirm_required");
        }
      }
    }
  }
  if (resolvedConfidence === "low") {
    _saveDraft(from, {
      ...draft,
      state: "awaiting_address_pin_confirm",
      pending_decoded_place: decodedPlace || destBase.place_label || "",
      pending_maps_url: url || "",
      address_pin_confirm: {
        mode: "semantic_place_conflict",
        address_text: addressText,
        decoded_place: decodedPlace || destBase.place_label || "",
        gmaps_link: url || "",
      },
    });
    _log("sbsr-address-pin-check", "confidence=low");
    _log("sbsr-address-pin-check", "quote_blocked_pending_confirmation");
    await _sendMessage(
      from,
      "Alamat tertulis dan titik Maps-nya berbeda cukup jauh ya Kak 🤍\n\n" +
      `Alamat tertulis:\n${addressText}\n\n` +
      `Titik Maps:\n${decodedPlace || destBase.place_label || "-" }\n\n` +
      "Yang benar dipakai yang mana?\n1. Pakai alamat tertulis\n2. Kirim ulang titik Maps\n3. Sambungkan ke admin"
    );
    return true;
  }
  if (resolvedConfidence === "medium") {
    _log("sbsr-address-pin-check", "confidence=medium");
    _log("sbsr-address-pin-check", "soft_confirm_required");
  }
  if (resolvedConfidence === "high") {
    _log("sbsr-address-pin-check", "confidence=high");
  }

  // Persist destination + address to draft so quote.mjs picks it up via fallback.
  // Clear pending_address_text now that it's been consumed into destination.address_text.
  // 2026-05-07: if this URL differs from any previously-confirmed pin on the draft,
  // RESET pin_confirmed_at so the soft-confirm gate re-fires. Without this, a returning
  // customer who shares a NEW pin gets quoted silently against the new destination
  // because their old pin_confirmed_at timestamp still satisfies the gate.
  const isNewPin = !!(url && (!draft.destination?.gmaps_link || draft.destination.gmaps_link !== url));
  _saveDraft(from, {
    ...draft,
    destination: destBase,
    ...(url ? { gmaps_link: url } : {}),
    address_pin_validation_passed: addressPinValidationPassed ? true : draft.address_pin_validation_passed,
    pending_address_text: null,
    pending_address_text_at: null,
    pin_confirmed_at: url ? (isNewPin ? null : draft.pin_confirmed_at) : (draft.pin_confirmed_at || new Date().toISOString()),
  });

  // Validate typed address vs pin distance before quote.
  if (await maybeHandleAddressPinDistanceGate(from, draft, addressText, destBase, url)) {
    return true;
  }

  // Soft-confirm gate is only for URL-based pins. Native WhatsApp location already
  // gives us deterministic coordinates, so proceed directly once address text exists.
  const _draftPostSave = _loadDraft(from);
  if (url && !_draftPostSave?.skip_pin_soft_confirm && !_draftPostSave?.address_pin_validation_passed && (!_draftPostSave?.pin_confirmed_at || resolvedConfidence === "medium")) {
    _saveDraft(from, { ..._draftPostSave, state: "awaiting_pin_confirm" });
    await sendPinConfirmPrompt(from, _draftPostSave, addressText, url);
    if (resolvedConfidence === "medium") {
      _log("sbsr-addr-quote", "waiting_confirmation_before_quote");
    }
    _log("sbsr-addr-quote", "soft-confirm sent for " + from + ", waiting for YA before quote (newPin=" + isNewPin + ")");
    return true; // gate the quote until customer confirms
  }

  // 2026-05-07: REFUSE TO QUOTE if any Risol item has ambiguous form.
  // SOUL.md (line ~179) says LLM must ask "goreng atau frozen?" before persisting.
  // If a null-form Risol slipped past (LLM didn't ask), abort quote and inject
  // bridge context so the LLM asks now rather than silently defaulting to bike.
  // Without this guard, classifyCart treats null-form items as "neither frozen nor
  // goreng" → falls through to default-bike → cold-chain Paxel never auto-selected.
  const ambiguousRisol = (draft.items || []).filter(it => /Risol/i.test(it.name || '') && !it.form);
  if (ambiguousRisol.length > 0) {
    const names = ambiguousRisol.map(it => it.name).join(", ");
    _log("sbsr-addr-quote", `ABORTING quote — ambiguous form on: ${names}`);
    try {
      await _sendMessage(from,
        "Sebelum Mintu hitung ongkir, boleh dipastikan dulu Kak — risol-nya mau yang **goreng** (matang siap makan) atau **frozen** (mentah, bisa disimpen)? 🤍\n\n" +
        "Kalau ada yang campur (misal sebagian goreng + sebagian frozen), boleh diketik per item ya."
      );
    } catch (e) { _log("sbsr-addr-quote", "ambiguous-form prompt err: " + e.message); }
    setPendingBridgeContext(from, [
      "Bridge sudah minta customer klarifikasi goreng vs frozen untuk: " + names,
      "JANGAN fire quote sampai semua item Risol punya form jelas (goreng/frozen).",
      "Setelah customer jawab, update draft.items[].form sesuai jawabannya.",
    ].join("\n"));
    return true;  // handled — wait for clarification
  }

  // Build the quote payload inline — items already in draft, frozen flag inferred
  const isFrozen = (draft.items || []).some(it => it.form === 'frozen');
  // 2026-05-07: scrub stale customer_preference if incompatible with current cart.
  // tryHandleFrozenCourierChoice writes customer_preference (e.g. 'paxel') for the
  // frozen flow; if that draft isn't reset before the next order and the new cart
  // is goreng-only, pickCourier's "preference always wins" rule forces Paxel for a
  // cart that should naturally go Gosend. Same family of state-leak as the
  // destination merge fix.
  let validPref = draft.customer_preference || null;
  if (validPref === 'paxel' && !isFrozen) {
    _log("sbsr-addr-quote", `clearing stale customer_preference=paxel for non-frozen cart (was set by prior frozen order)`);
    _saveDraft(from, { ..._loadDraft(from), customer_preference: null });
    validPref = null;
  }
  const quotePayload = JSON.stringify({
    phone: from,
    items: draft.items,
    destination: { ...destBase },
    frozen: isFrozen,
    customerPreference: validPref,
  });

  _log("sbsr-addr-quote", "fire quote for " + from + " items=" + draft.items.length + " frozen=" + isFrozen + " pref=" + (validPref || "none"));

  // 1) quote — retry once on transient parse / Biteship failures before falling through.
  // Without retry+context-on-fail, Order #1 in 2026-05-05 04:19 logs hung silently and
  // the LLM hallucinated "invoice-nya udah dikirim" because no quote was ever generated.
  const runQuoteOnce = () => new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", "sbsr-openclaw-1",
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-quote.mjs",
    ], { timeout: 30000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => {
      try {
        const parsed = parseScriptJSON(stdout);
        resolve(parsed || { ok: false, error: "no parseable output", stdout, stderr });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
    child.stdin.end(quotePayload);
  });

  let quoteRes = await runQuoteOnce();
  if (!quoteRes || !quoteRes.ok) {
    _log("sbsr-addr-quote", "quote attempt 1 failed: " + (quoteRes?.error || "?") + ", retrying once");
    await new Promise(r => setTimeout(r, 800));
    quoteRes = await runQuoteOnce();
  }

  // === BIKS 2026-05-07: FROZEN CUSTOMER-CHOICE ===
  // If quoteShipping returned needs_customer_choice (frozen-only cart, no
  // preference set), present BOTH options and wait for "1" or "2" reply.
  // The cached options are persisted on the draft (quote_options[]) by
  // sentuh-quote.mjs; tryHandleFrozenCourierChoice picks them up.
  if (quoteRes && quoteRes.ok && quoteRes.needs_customer_choice && Array.isArray(quoteRes.options) && quoteRes.options.length >= 2) {
    const opts = quoteRes.options;
    const lines = [
      `Untuk pengiriman frozen, ada 2 pilihan ya Kak — silakan pilih 🤍`,
      ``,
    ];
    opts.forEach((o, i) => {
      const eta = o.eta_text ? ` · ETA ${o.eta_text}` : "";
      lines.push(`${i + 1}. ${o.courier_label} — Rp ${Number(o.ongkir).toLocaleString("id-ID")}${eta}`);
    });
    lines.push("");
    lines.push(`Balas *1* atau *2* ya Kak.`);
    _saveDraft(from, {
      ..._loadDraft(from),
      state: "awaiting_courier_choice",
      courier_choice_sent_at: new Date().toISOString(),
    });
    try {
      await _sendMessage(from, lines.join("\n"));
      _log("sbsr-addr-quote", "frozen-choice prompt sent to " + from + " options=" + opts.map(o => o.courier).join("+"));
    } catch (e) {
      _log("sbsr-addr-quote", "frozen-choice send err: " + e.message);
    }
    setPendingBridgeContext(from, [
      "Bridge sudah kirim 2 pilihan ongkir frozen (Paxel + Gosend) ke customer.",
      "STATE: awaiting_courier_choice. Quote_options sudah disimpan di draft.",
      "TUNGGU customer balas '1' atau '2' (atau nama courier). Bridge akan auto-quote ulang dengan pilihan tersebut.",
      "JANGAN tanya alamat / pin lagi — sudah ada. JANGAN tampilkan invoice — belum.",
    ].join("\n"));
    return true; // gate further processing until customer picks
  }
  // === END BIKS frozen customer-choice ===

  if (!quoteRes || !quoteRes.ok) {
    _log("sbsr-addr-quote", "quote failed twice for " + from + ": " + (quoteRes?.error || "?"));
    // Reply directly to customer; arm LLM with anti-fabrication context for the next turn.
    try {
      await _sendMessage(from,
        "Maaf ya Kak, Mintu lagi gagal cek ongkir 🙏\n\n" +
        "Boleh kirim ulang share pin Google Maps-nya? Atau ketik alamat lengkap (kelurahan + kecamatan + kota) biar Mintu coba lagi 🤍"
      );
    } catch (_) {}
    setPendingBridgeContext(from, [
      "Bridge sudah coba 2x cek ongkir lewat sentuh-quote.mjs dan GAGAL (Biteship/parser error).",
      "Bridge sudah minta customer share ulang pin Google Maps.",
      "Draft sudah punya: nama (" + (draft.customer_name || "?") + "), alamat, " + draft.items.length + " item.",
      "",
      "ATURAN:",
      "- JANGAN claim ongkir / invoice / total sudah dikirim — belum ada yang dikirim.",
      "- JANGAN minta nama / alamat lagi — sudah disimpan.",
      "- Tunggu customer kirim pin baru. Begitu pin masuk, bridge akan coba lagi otomatis.",
      "- Kalau customer follow-up sebelum kirim pin baru ('udah?', 'mana?'), jelaskan singkat bahwa Mintu masih nunggu pin baru karena tadi gagal kebaca.",
    ].join("\n"));
    return true;  // handled at bridge level — do NOT fall through to LLM
  }

  // 2) invoice — re-load draft (quote may have updated it with destination/courier)
  const draftAfterQuote = _loadDraft(from) || draft;
  const invoicePayload = JSON.stringify({
    phone: from,
    items: draftAfterQuote.items,
    ongkir: quoteRes.ongkir,
    customer_name: draftAfterQuote.customer_name,
    destination: { ...destBase },
    courier_label: quoteRes.courier_label,
    eta_text: quoteRes.eta_text,
  });

  const invoiceRes = await new Promise((resolve) => {
    const cp = require("child_process");
    const child = cp.spawn("docker", [
      "exec", "-i", "sbsr-openclaw-1",
      "node", "/data/sentuhrasa-pdf/scripts/sentuh-invoice.mjs",
    ], { timeout: 15000 });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", code => {
      // sentuh-invoice prints text between "---" markers when run as main; pull text from there
      const m = stdout.match(/^---\s*\n([\s\S]*?)\n---/m);
      if (m) resolve({ ok: true, text: m[1] });
      else resolve({ ok: false, error: "no invoice text in stdout", stdout, stderr });
    });
    child.stdin.end(invoicePayload);
  });

  if (!invoiceRes.ok) {
    _log("sbsr-addr-quote", "invoice failed: " + (invoiceRes.error || "?") + ", falling through");
    return false;
  }

  // 3) prepend a short ack line + send to customer
  const ackText = `Baik Kak ${draftAfterQuote.customer_name || ""}, ongkirnya sudah masuk ya 🤍\n\n` + invoiceRes.text;
  try {
    await _sendMessage(from, ackText);
    _log("sbsr-addr-quote", "sent invoice to " + from + " courier=" + quoteRes.courier_label + " ongkir=" + quoteRes.ongkir);
  } catch (e) {
    _log("sbsr-addr-quote", "send err: " + e.message);
    return false;
  }

  // Persist post-invoice state so OK→QRIS intercept fires + LLM doesn't re-ask.
  // sentuh-quote.mjs returns ongkir; subtotal is computed from items; grand_total may be
  // returned by the script — fall back to subtotal+ongkir if not.
  const subtotal = (draftAfterQuote.items || []).reduce(
    (s, it) => s + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0
  );
  const ongkirN = Number(quoteRes.ongkir) || 0;
  const grandTotal = Number(quoteRes.grand_total) || (subtotal + ongkirN);
  _saveDraft(from, {
    ...draftAfterQuote,
    state: "awaiting_invoice_confirm",
    awaiting_pin_confirm: false,
    skip_pin_soft_confirm: false,
    address_pin_validation_passed: false,
    subtotal,
    ongkir: ongkirN,
    grand_total: grandTotal,
    expected_total: grandTotal,
    courier: quoteRes.courier,
    courier_label: quoteRes.courier_label,
    courier_type: quoteRes.courier_type || null,
    eta_text: quoteRes.eta_text || null,
    frozen: isFrozen,
    invoice_sent_at: new Date().toISOString(),
  });
  void syncCustomerDbEvent(from, "invoice_created", _loadDraft(from) || draftAfterQuote, {
    lastResponse: "invoice_created",
    lastOffer: draftAfterQuote.use_case ? `use_case:${draftAfterQuote.use_case}` : "invoice",
  });

  // Arm LLM with full state for the next turn so it doesn't re-ask for info already given.
  const itemsLine = (draftAfterQuote.items || [])
    .map(it => `${it.name} x${it.qty} (${fmtRupiah((Number(it.unit_price) || 0) * (Number(it.qty) || 0))})`)
    .join(", ");
  setPendingBridgeContext(from, [
    "Bridge baru saja menjalankan quote + invoice deterministik dan sudah mengirim invoice ke customer.",
    "STATE: awaiting_invoice_confirm — menunggu customer balas OK/YA agar bridge lanjut ke QRIS.",
    `Customer: ${draftAfterQuote.customer_name || "?"}`,
    `Items: ${itemsLine}`,
    `Subtotal: ${fmtRupiah(subtotal)}`,
    `Alamat: ${addressText}`,
    `Maps: ${url}`,
    `Kurir: ${quoteRes.courier_label || "?"}, ongkir ${fmtRupiah(ongkirN)}` + (quoteRes.eta_text ? `, ETA ${quoteRes.eta_text}` : ""),
    `Grand total: ${fmtRupiah(grandTotal)}`,
    "",
    "ATURAN:",
    "- JANGAN tanya ulang nama / alamat / pin maps / ongkir — semua sudah di atas.",
    "- Kalau customer tanya frozen/aman/ETA/varian, jawab langsung pakai info di atas + faq.md, BUKAN dengan minta info lagi.",
    "- Kalau customer balas OK / YA / sip / siap / lanjut / gas — bridge yang akan handle pembayaran. Cukup balas singkat 'siap Kak' ATAU jangan reply (bridge intercept akan kirim QRIS).",
    "- Kalau customer minta cancel/ubah pesanan, jelaskan Mintu hubungkan ke admin.",
    "- Kalau customer kirim TYPO atau text pendek tidak jelas (mis. 'pl', 'p', 'oc', 'okk', 'yo', 'lanjt', 'ya udah', 'gas dong') — JANGAN kirim katalog/menu lagi. Tafsirkan sebagai 'OK' yang typo dan minta konfirmasi singkat: \"Maksudnya OK ya Kak? Kalau iya, Mintu lanjut ke pembayaran 🤍\". JANGAN emit [MENU] / [CATALOG] saat customer di state ini.",
    "- Kalau customer kirim greeting (halo/hi/p/menu) di state ini, jangan reset — confirm dulu apakah mereka mau lanjut bayar atau cancel order.",
  ].join("\n"));
  return true;
}


module.exports = { init, tryHandleAddressAndQuote };
