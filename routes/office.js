const express = require('express');
const ExcelJS = require('exceljs');
const ops = require('../services/operations');
const { requireRole } = require('./auth');

const router = express.Router();

router.use(requireRole(['middle_office', 'back_office']));

function resolvePeriod(query) {
  const today = new Date();
  const defaultEnd = today.toISOString().slice(0, 10);
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const defaultStart = startOfMonth.toISOString().slice(0, 10);

  return {
    startDate: query.start_date || defaultStart,
    endDate: query.end_date || defaultEnd,
  };
}

function buildRows(operations) {
  return operations.map((op) => {
    const finalAmount = op.taux_final != null ? op.montant * op.taux_final : null;
    return {
      id: op.id,
      agence: op.agence_name,
      client: op.nom_client,
      sens: op.sens,
      source_currency: op.currency_from || op.devise,
      target_currency: op.currency_to || 'TND',
      amount_source: op.montant,
      spot_rate: op.taux_spot,
      final_rate: op.taux_final,
      final_amount: finalAmount,
      status: op.status,
      created_at: op.created_at,
      decided_at: op.decided_at,
      comment: op.decision_comment,
    };
  });
}

router.get('/', (req, res) => {
  const { startDate, endDate } = resolvePeriod(req.query);
  const operations = ops.listAllBetween(startDate, endDate);
  res.render('office_dashboard', {
    operations,
    startDate,
    endDate,
    error: null,
  });
});

router.get('/export', async (req, res, next) => {
  try {
    const { startDate, endDate } = resolvePeriod(req.query);
    const operations = ops.listAllBetween(startDate, endDate);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Operations');

    sheet.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Agence', key: 'agence', width: 18 },
      { header: 'Client', key: 'client', width: 24 },
      { header: 'Sens', key: 'sens', width: 12 },
      { header: 'Devise source', key: 'source_currency', width: 14 },
      { header: 'Devise cible', key: 'target_currency', width: 14 },
      { header: 'Montant source', key: 'amount_source', width: 16 },
      { header: 'Taux spot', key: 'spot_rate', width: 12 },
      { header: 'Taux final', key: 'final_rate', width: 12 },
      { header: 'Montant final', key: 'final_amount', width: 16 },
      { header: 'Statut', key: 'status', width: 24 },
      { header: 'Cree le', key: 'created_at', width: 20 },
      { header: 'Decide le', key: 'decided_at', width: 20 },
      { header: 'Commentaire', key: 'comment', width: 30 },
    ];

    buildRows(operations).forEach((row) => sheet.addRow(row));

    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `operations_${startDate}_${endDate}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

module.exports = router;