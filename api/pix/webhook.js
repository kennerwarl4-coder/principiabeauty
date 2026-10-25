const { getTransaction, verifyWebhookSignature } = require('../_lib/bravopay');
const { reportPurchase } = require('../_lib/report-purchase');

// A assinatura HMAC é calculada sobre o corpo CRU. No Express o server.js guarda esse corpo
// em req.rawBody; em serverless (Vercel) lemos o stream direto, antes de tocar em req.body.
async function readRawBody(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// Evento: { id: "evt_...", type: "transaction.paid", created, data: { ...transação } }.
// Configure a URL em BravoPay > Dashboard > Integrações e cole o "whsec_..." em
// BRAVOPAY_WEBHOOK_SECRET. O evt id é estável entre retentativas, e tanto a UTMify (por
// orderId) quanto a Meta (por eventId) deduplicam um reenvio.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const secret = process.env.BRAVOPAY_WEBHOOK_SECRET;
    const signature = req.headers['bravopay-signature'] || req.headers['x-bravopay-signature'];

    if (secret) {
      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        console.warn('[BravoPay webhook] Assinatura inválida — evento descartado.');
        res.status(401).json({ message: 'Invalid signature' });
        return;
      }
    }

    event = JSON.parse(rawBody);
  } catch (error) {
    console.error('[BravoPay webhook] Corpo inválido:', error.message);
    res.status(400).json({ message: 'Invalid body' });
    return;
  }

  console.log('[BravoPay webhook]', event.id, event.type, event.data && event.data.id);

  try {
    if (event.type === 'transaction.paid' && event.data && event.data.id) {
      let transaction = event.data;

      // Sem secret configurado não dá pra confiar no corpo — reconsulta na BravoPay.
      if (!process.env.BRAVOPAY_WEBHOOK_SECRET) {
        console.warn('[BravoPay webhook] BRAVOPAY_WEBHOOK_SECRET não configurado — reconsultando a transação.');
        transaction = await getTransaction(event.data.id);
      }

      if (transaction.status === 'PAID') {
        const metadata = (transaction.metadata && typeof transaction.metadata === 'object') ? transaction.metadata : {};
        const customer = transaction.customer || {};
        const tracking = {
          ...(transaction.tracking || {}),
          src: metadata.src || null,
          sck: metadata.sck || null,
        };

        await reportPurchase({
          orderId: transaction.external_reference || metadata.order_id || transaction.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          createdAt: metadata.created_at || transaction.created_at,
          tracking,
          amount: transaction.amount_cents / 100,
          product: metadata.product_name ? { id: metadata.product_id, name: metadata.product_name } : undefined,
          eventId: metadata.meta_event_id,
          fbp: metadata.meta_fbp,
          fbc: metadata.meta_fbc,
          clientIp: metadata.meta_ip,
          userAgent: metadata.meta_ua,
          eventSourceUrl: `${process.env.PUBLIC_BASE_URL || ''}/checkout/`,
        });
      }
    }
  } catch (error) {
    console.error('[BravoPay webhook] Erro ao processar evento:', error.message);
  }

  res.status(200).end();
};
