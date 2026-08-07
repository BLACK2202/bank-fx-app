const express = require("express");
const db = require("../db");
const ops = require("../services/operations");
const { getSpotRate, readRatesFresh } = require("../services/excelRates");
const { requireRole } = require("./auth");

const router = express.Router();

router.use(requireRole("agency"));

router.get("/", async (req, res) => {
  const agenceId = req.session.user.agenceId;
  const operations = ops.listForAgency(agenceId);
  let ratesError = null;
  let snapshot = null;
  try {
    snapshot = await readRatesFresh();
  } catch (e) {
    ratesError = e.message;
  }
  res.render("agency_dashboard", {
    operations,
    threshold: ops.NEGOTIATION_THRESHOLD,
    snapshot,
    ratesError,
  });
});

router.get("/nouvelle", (req, res) => {
  const devises = db.prepare("SELECT * FROM devises ORDER BY code").all();
  res.render("new_operation", { devises, error: null, form: {} });
});

router.post("/nouvelle", async (req, res) => {
  const devises = db.prepare("SELECT * FROM devises ORDER BY code").all();
  const {
    nature_sujet,
    nom_client,
    numero_compte,
    sens,
    currency_from,
    currency_to,
    date_valeur,
    montant,
  } = req.body;
  const fixedCurrencyTo = currency_to || "TND";

  if (
    !nature_sujet ||
    !nom_client ||
    !numero_compte ||
    !sens ||
    !currency_from ||
    !date_valeur ||
    !montant
  ) {
    return res.render("new_operation", {
      devises,
      error: "Merci de remplir tous les champs.",
      form: req.body,
    });
  }
  const montantNum = Number(montant);
  if (Number.isNaN(montantNum) || montantNum <= 0) {
    return res.render("new_operation", {
      devises,
      error: "Montant invalide.",
      form: req.body,
    });
  }
  if (currency_from === fixedCurrencyTo) {
    return res.render("new_operation", {
      devises,
      error: "Veuillez choisir une devise source autre que TND.",
      form: req.body,
    });
  }

  try {
    const { id } = await ops.createOperation({
      agenceId: req.session.user.agenceId,
      natureSujet: nature_sujet,
      nomClient: nom_client,
      numeroCompte: numero_compte,
      sens,
      currencyFrom: currency_from,
      currencyTo: fixedCurrencyTo,
      dateValeur: date_valeur,
      montant: montantNum,
      createdBy: req.session.user.id,
    });
    res.redirect(`/agence/operation/${id}`);
  } catch (e) {
    res.render("new_operation", { devises, error: e.message, form: req.body });
  }
});

router.get("/operation/:id", (req, res) => {
  const op = ops.getOperation(req.params.id);
  if (!op || op.agence_id !== req.session.user.agenceId) {
    return res
      .status(404)
      .render("error", { message: "Operation introuvable." });
  }
  res.render("operation_detail", {
    op,
    threshold: ops.NEGOTIATION_THRESHOLD,
    error: null,
  });
});

router.post("/operation/:id/accepter-spot", (req, res) => {
  try {
    ops.acceptSpot(req.params.id, req.session.user.agenceId);
  } catch (e) {
    return res.render("operation_detail", {
      op: ops.getOperation(req.params.id),
      threshold: ops.NEGOTIATION_THRESHOLD,
      error: e.message,
    });
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/annuler", (req, res) => {
  try {
    ops.cancelAfterRefusal(req.params.id, req.session.user.agenceId);
  } catch (e) {
    return res.render("operation_detail", {
      op: ops.getOperation(req.params.id),
      threshold: ops.NEGOTIATION_THRESHOLD,
      error: e.message,
    });
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/accepter-taux", (req, res) => {
  try {
    ops.acceptNegotiatedRate(req.params.id, req.session.user.agenceId);
  } catch (e) {
    return res.render("operation_detail", {
      op: ops.getOperation(req.params.id),
      threshold: ops.NEGOTIATION_THRESHOLD,
      error: e.message,
    });
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/refuser-taux", (req, res) => {
  try {
    ops.refuseNegotiatedRate(req.params.id, req.session.user.agenceId);
  } catch (e) {
    return res.render("operation_detail", {
      op: ops.getOperation(req.params.id),
      threshold: ops.NEGOTIATION_THRESHOLD,
      error: e.message,
    });
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/negocier", (req, res) => {
  const requestedTaux = req.body.requested_taux
    ? Number(req.body.requested_taux)
    : null;
  try {
    ops.requestNegotiation(
      req.params.id,
      req.session.user.agenceId,
      requestedTaux,
    );
  } catch (e) {
    return res.render("operation_detail", {
      op: ops.getOperation(req.params.id),
      threshold: ops.NEGOTIATION_THRESHOLD,
      error: e.message,
      form: req.body,
    });
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

module.exports = router;
