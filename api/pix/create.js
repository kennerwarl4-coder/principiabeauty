const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { createTransaction } = require('../_lib/bravopay');
const { validateOrderInput, onlyDigits } = require('../_lib/validate');
const { reportOrder, buildOrderPayload } = require('../_lib/utmify');

const MIN_AMOUNT_CENTS = 500;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress;
}

function str(value, max) {
  return value == null ? '' : String(value).slice(0, max || 500);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  try {
    const validationError = validateOrderInput(req.body);
    if (validationError) {
      res.status(400).json({ message: validationError });
      return;
    }

    const { amount, client, products, tracking, meta } = req.body;
    const amountCents = Math.round(amount * 100);
    if (amountCents < MIN_AMOUNT_CENTS) {
      res.status(400).json({ message: 'Valor mínimo para pagamento via PIX é R$ 5,00.' });
      return;
    }

    const identifier = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const trackingData = tracking && typeof tracking === 'object' ? tracking : {};
    const metaData = meta && typeof meta === 'object' ? meta : {};
    const firstProduct = Array.isArray(products) && products[0] ? products[0] : null;

    const customer = {
      name: String(client.name).trim(),
      email: String(client.email).trim(),
      phone: client.phone,
      document: client.document,
    };

    // A BravoPay devolve external_reference, metadata, customer e tracking intactos no GET e
    // em todos os webhooks — é por aí que o webhook recupera o pedido pra reportar à
    // UTMify/Meta CAPI. metadata aceita no máximo 20 chaves.
    const payload = {
      amount_cents: amountCents,
      method: 'pix',
      customer: {
        email: customer.email,
        name: customer.name,
        cpf: onlyDigits(customer.document),
        phone: onlyDigits(customer.phone),
      },
      description: str(firstProduct && firstProduct.name ? firstProduct.name : 'Pedido Principia', 300),
      external_reference: identifier,
      metadata: {
        order_id: identifier,
        created_at: createdAt,
        meta_event_id: str(metaData.eventId),
        meta_fbp: str(metaData.fbp),
        meta_fbc: str(metaData.fbc),
        meta_ua: str(req.headers['user-agent']),
        meta_ip: str(getClientIp(req)),
        product_id: str(firstProduct && firstProduct.id, 50),
        product_name: str(firstProduct && firstProduct.name, 200),
        src: str(trackingData.src),
        sck: str(trackingData.sck),
      },
      // Sem UTMs a venda aparece sem origem na integração UTMify da própria BravoPay.
      utm: {
        source: str(trackingData.utm_source),
        medium: str(trackingData.utm_medium),
        campaign: str(trackingData.utm_campaign),
        content: str(trackingData.utm_content),
        term: str(trackingData.utm_term),
        fbclid: str(trackingData.fbclid),
        gclid: str(trackingData.gclid),
        ttclid: str(trackingData.ttclid),
      },
    };

    // Opcional: produto real cadastrado na BravoPay (recomendado se a UTMify estiver ligada
    // no painel deles — sem isso a venda vai como "API Charge").
    if (process.env.BRAVOPAY_PRODUCT_ID) {
      payload.product_id = process.env.BRAVOPAY_PRODUCT_ID;
    }

    const charge = await createTransaction(payload, identifier);
    const copyPaste = charge.pix && charge.pix.copy_paste;
    if (!copyPaste) {
      const error = new Error('A BravoPay não retornou o código PIX.');
      error.status = 502;
      error.details = charge;
      throw error;
    }
    const qrImage = await QRCode.toDataURL(copyPaste, { margin: 1, width: 320 });

    await reportOrder(buildOrderPayload({
      orderId: identifier,
      status: 'waiting_payment',
      createdAt,
      approvedDate: null,
      customer,
      amount,
      tracking: trackingData,
      product: firstProduct,
    }));

    res.status(201).json({
      transactionId: charge.id,
      identifier,
      status: charge.status,
      amount,
      pix: {
        code: copyPaste,
        qrImage,
        expiresAt: charge.pix.expires_at || null,
      },
    });
  } catch (error) {
    console.error('Erro ao criar cobrança PIX:', JSON.stringify(error.details || error.message));
    res.status(error.status || 500).json({
      message: error.message || 'Erro interno ao criar cobrança PIX.',
    });
  }
};
