const express = require('express');
const ops = require('../services/operations');
const { readRatesFresh } = require('../services/excelRates');

const { requireRole } = require('./auth');

const router = express.Router();

router.use(requireRole('head_office'));

router.get('/', async (req, res) => {
  const pending = ops.listPendingNegotiations();
  let ratesError = null;
  let snapshot = null;
  try {
    snapshot = await readRatesFresh();
  } catch (e) {
    ratesError = e.message;
  }
  res.render('headoffice_dashboard', { pending, snapshot, ratesError });
});

router.get('/toutes', (req, res) => {
  const all = ops.listAll();
  res.render('headoffice_all', { all });
});

router.get('/negociation/:id', (req, res) => {
  const op = ops.getOperation(req.params.id);
  if (!op) return res.status(404).render('error', { message: 'Operation introuvable.' });
  res.render('headoffice_decision', { op, error: null });
});

router.post('/negociation/:id/decision', (req, res) => {
  const { decision, final_taux, comment } = req.body;
  try {
    ops.decideNegotiation(req.params.id, req.session.user.id, decision, {
      finalTaux: final_taux ? Number(final_taux) : undefined,
      comment,
    });
  } catch (e) {
    return res.render('headoffice_decision', { op: ops.getOperation(req.params.id), error: e.message });
  }
  res.redirect('/siege');
});

module.exports = router;
