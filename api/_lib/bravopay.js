const crypto = require('node:crypto');

const BRAVOPAY_BASE_URL = 'https://bravopay.club/api/v1';

function authHeaders(extra) {
  const apiKey = process.env.BRAVOPAY_API_KEY;

  if (!apiKey) {
    throw new Error('Credencial da BravoPay não configurada (BRAVOPAY_API_KEY).');
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

// Erros da BravoPay vêm sempre como { error: { code, message, details } }.
async function parseJsonResponse(response, fallbackMessage) {
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const error = new Error(`Resposta inesperada da BravoPay (HTTP ${response.status}).`);
    error.status = 502;
    throw error;
  }

  if (!response.ok) {
    const apiError = data && data.error ? data.error : {};
    const error = new Error(apiError.message || fallbackMessage);
    error.status = response.status;
    error.code = apiError.code;
    error.details = data;
    throw error;
  }

  return data;
}

// Idempotency-Key (TTL 24h na BravoPay) garante que um reenvio do mesmo pedido não gere
// uma segunda cobrança.
async function createTransaction(payload, idempotencyKey) {
  const response = await fetch(`${BRAVOPAY_BASE_URL}/transactions`, {
    method: 'POST',
    headers: authHeaders(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined),
    body: JSON.stringify(payload),
  });

  return parseJsonResponse(response, 'Falha ao criar cobrança PIX na BravoPay.');
}

async function getTransaction(id) {
  const response = await fetch(`${BRAVOPAY_BASE_URL}/transactions/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: authHeaders(),
  });

  return parseJsonResponse(response, 'Falha ao consultar transação na BravoPay.');
}

// Header "BravoPay-Signature: t=<ts>,v1=<hex>", onde v1 = HMAC-SHA256(secret, `${t}.${rawBody}`).
// rawBody precisa ser o corpo CRU do request — re-serializar o JSON quebra a assinatura.
function verifyWebhookSignature(rawBody, headerValue, secret, toleranceSec = 300) {
  if (!rawBody || !headerValue || !secret) return false;

  const parts = {};
  for (const kv of String(headerValue).split(',')) {
    const index = kv.indexOf('=');
    if (index > 0) parts[kv.slice(0, index).trim()] = kv.slice(index + 1).trim();
  }

  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(parts.v1);
  return expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

module.exports = { createTransaction, getTransaction, verifyWebhookSignature };
