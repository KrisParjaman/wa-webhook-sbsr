#!/usr/bin/env node
const https = require('https');
const fs = require('fs');

const OPENROUTER_API_KEY = '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';
const MODEL = 'google/gemini-2.0-flash-001';

const imageUrl = process.argv[2];
if (!imageUrl) {
  console.error('Usage: node read-receipt.js <image_url>');
  process.exit(1);
}

const prompt = `You are a receipt/invoice OCR assistant. Extract the following from this receipt image:

1. Merchant/store name or bank name (e.g. "BCA", "Jago", "Tokopedia")
2. Date on receipt/transfer
3. List of items with prices (if applicable)
4. Subtotal
5. Tax (if any)
6. Total amount
7. Berita/Keterangan/Remarks - the description or purpose of the transaction (e.g. "Belanja material", "DP Proyek"). Look for fields labeled "Berita", "Keterangan", "Catatan", "Remarks", "Description"
8. Recipient name - who the money was sent to (for transfers)
9. Recipient account - bank account number of recipient
10. Sender name - who sent the money

Return ONLY a JSON object in this exact format (no markdown, no code fences):
{
  "merchant": "store or bank name",
  "date": "DD Mon YYYY (e.g. 3 April 2026)",
  "items": [
    {"name": "item name", "qty": 1, "price": 50000}
  ],
  "subtotal": 50000,
  "tax": 0,
  "total": 50000,
  "currency": "IDR",
  "berita": "transaction description/berita/keterangan if available, otherwise null",
  "recipient_name": "who received the money, otherwise null",
  "recipient_account": "bank account number, otherwise null",
  "sender_name": "who sent the money, otherwise null"
}

If you cannot read a field, use null. Always use numbers (not strings) for amounts.`;

const body = JSON.stringify({
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }
  ],
  max_tokens: 1024,
  temperature: 0.1
});

const options = {
  hostname: 'openrouter.ai',
  path: '/api/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': 'https://airoklin.com',
    'X-Title': 'Airoklin Receipt Reader'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      if (response.error) {
        console.error('API error:', response.error.message || JSON.stringify(response.error));
        process.exit(1);
      }
      const content = response.choices[0].message.content.trim();
      // Try to parse as JSON to validate, then output
      let cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      // If JSON parse fails, output the raw text so the bot can still use it
      try {
        const response = JSON.parse(data);
        const content = response.choices[0].message.content.trim();
        console.log(content);
      } catch (e2) {
        console.error('Failed to parse response:', e2.message);
        process.exit(1);
      }
    }
  });
});

req.on('error', (e) => {
  console.error('Request failed:', e.message);
  process.exit(1);
});

req.write(body);
req.end();
