const { getTransaction } = require('../../_lib/bravopay');

// Status BravoPay: PENDING | PAID | EXPIRED | REFUNDED | CHARGEBACK
module.exports = async (req, res) => {
  try {
    const { id } = req.query;
    const transaction = await getTransaction(id);
    res.status(200).json({
      status: transaction.status,
      paidAt: transaction.paid_at || null,
    });
  } catch (error) {
    console.error('Erro ao consultar transação PIX:', JSON.stringify(error.details || error.message));
    res.status(error.status || 500).json({
      message: error.message || 'Erro interno ao consultar transação PIX.',
    });
  }
};
