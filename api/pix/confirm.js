const { getTransaction } = require('../_lib/bravopay');
const { reportPurchase } = require('../_lib/report-purchase');

// Chamado pelo navegador assim que ele mesmo detecta (via polling em /api/pix/status) que
// o pagamento foi confirmado — cobre o caso em que o webhook da BravoPay ainda não chegou
// (ou não está configurado) enquanto o cliente está na tela.
// NUNCA confia no "está pago" que o cliente alega: reconsulta a transação na BravoPay antes
// de reportar qualquer coisa pra UTMify/Meta.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  try {
    const { transactionId, orderId, name, email, phone, createdAt, tracking, amount, eventId, fbp, fbc, productId, productName } = req.body || {};

    if (!transactionId || typeof transactionId !== 'string') {
      res.status(400).json({ message: 'transactionId ausente.' });
      return;
    }

    const transaction = await getTransaction(transactionId);
    const status = transaction && transaction.status;

    if (status !== 'PAID') {
      res.status(200).json({ reported: false, status: status || 'unknown' });
      return;
    }

    const verifiedAmount = transaction.amount_cents != null ? transaction.amount_cents / 100 : amount;
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = (typeof forwarded === 'string' && forwarded.length > 0)
      ? forwarded.split(',')[0].trim()
      : (req.socket && req.socket.remoteAddress);

    await reportPurchase({
      orderId: transaction.external_reference || orderId || transactionId,
      name,
      email,
      phone,
      createdAt,
      tracking,
      amount: verifiedAmount,
      product: productName ? { id: productId, name: productName } : undefined,
      eventId,
      fbp,
      fbc,
      clientIp,
      userAgent: req.headers['user-agent'] || '',
      eventSourceUrl: `${process.env.PUBLIC_BASE_URL || ''}/checkout/obrigado.html`,
    });

    res.status(200).json({ reported: true, status });
  } catch (error) {
    console.error('[confirm] Erro ao confirmar/reportar compra:', JSON.stringify(error.details || error.message));
    res.status(error.status || 500).json({
      message: error.message || 'Erro interno ao confirmar pagamento.',
    });
  }
};
