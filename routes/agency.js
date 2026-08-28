const express = require("express");
const db = require("../db");
const ops = require("../services/operations");
const { getSpotRate, readRatesFresh } = require("../services/excelRates");
const { requireRole } = require("./auth");

const router = express.Router();

router.use(requireRole("agency"));

function renderOperationDetail(res, op, error = null, form = {}) {
  const audit = op ? ops.getAuditTrail(op.id) : [];
  return res.render("operation_detail", {
    op,
    threshold: ops.NEGOTIATION_THRESHOLD,
    error,
    form,
    audit,
  });
}

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
    numero_compte_confirm,
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
    !numero_compte_confirm ||
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

  if (numero_compte !== numero_compte_confirm) {
    return res.render("new_operation", {
      devises,
      error:
        "Les numeros de compte ne correspondent pas. Veuillez verifier si c'est correct.",
      form: req.body,
    });
  }

  const accountPattern = /^[0-9]{20}$/;
  if (!accountPattern.test(numero_compte)) {
    return res.render("new_operation", {
      devises,
      error: "Le numero de compte doit contenir exactement 20 chiffres.",
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
  return renderOperationDetail(res, op);
});

router.post("/operation/:id/accepter-spot", (req, res) => {
  try {
    ops.acceptSpot(req.params.id, req.session.user.agenceId);
  } catch (e) {
    ops.logOperationError({
      operationId: req.params.id,
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      route: req.originalUrl,
      action: "accept_spot",
      error: e,
    });
    return renderOperationDetail(
      res,
      ops.getOperation(req.params.id),
      e.message,
    );
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/annuler", (req, res) => {
  try {
    ops.cancelAfterRefusal(req.params.id, req.session.user.agenceId);
  } catch (e) {
    ops.logOperationError({
      operationId: req.params.id,
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      route: req.originalUrl,
      action: "cancel_operation",
      error: e,
    });
    return renderOperationDetail(
      res,
      ops.getOperation(req.params.id),
      e.message,
    );
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/accepter-taux", (req, res) => {
  try {
    ops.acceptNegotiatedRate(req.params.id, req.session.user.agenceId);
  } catch (e) {
    ops.logOperationError({
      operationId: req.params.id,
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      route: req.originalUrl,
      action: "accept_negotiated_rate",
      error: e,
    });
    return renderOperationDetail(
      res,
      ops.getOperation(req.params.id),
      e.message,
    );
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

router.post("/operation/:id/refuser-taux", (req, res) => {
  try {
    ops.refuseNegotiatedRate(req.params.id, req.session.user.agenceId);
  } catch (e) {
    ops.logOperationError({
      operationId: req.params.id,
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      route: req.originalUrl,
      action: "refuse_negotiated_rate",
      error: e,
    });
    return renderOperationDetail(
      res,
      ops.getOperation(req.params.id),
      e.message,
    );
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
    ops.logOperationError({
      operationId: req.params.id,
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      route: req.originalUrl,
      action: "request_negotiation",
      error: e,
      requestDetails: req.body,
    });
    return renderOperationDetail(
      res,
      ops.getOperation(req.params.id),
      e.message,
      req.body,
    );
  }
  res.redirect(`/agence/operation/${req.params.id}`);
});

module.exports = router;
