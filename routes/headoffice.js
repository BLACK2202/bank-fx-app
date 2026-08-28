const express = require("express");
const ops = require("../services/operations");
const { readRatesFresh } = require("../services/excelRates");

const { requireRole } = require("./auth");

const router = express.Router();

router.use(requireRole("head_office"));

router.get("/", async (req, res) => {
  const pending = ops.listPendingNegotiations();
  let ratesError = null;
  let snapshot = null;
  try {
    snapshot = await readRatesFresh();
  } catch (e) {
    ratesError = e.message;
  }
  res.render("headoffice_dashboard", { pending, snapshot, ratesError });
});

router.get("/toutes", (req, res) => {
  const all = ops.listAll();
  res.render("headoffice_all", { all });
});

router.get("/negociation/:id", (req, res) => {
  const op = ops.getOperation(req.params.id);
  if (!op)
    return res
      .status(404)
      .render("error", { message: "Operation introuvable." });
  const audit = ops.getAuditTrail(req.params.id);
  res.render("headoffice_decision", { op, audit, error: null });
});

router.post("/negociation/:id/decision", (req, res) => {
  const { decision, final_taux, reference_number, comment } = req.body;
  try {
    if (decision === "validate") {
      ops.validateOperation(
        req.params.id,
        req.session.user.id,
        reference_number,
        comment,
      );
    } else {
      ops.decideNegotiation(req.params.id, req.session.user.id, decision, {
        finalTaux: final_taux ? Number(final_taux) : undefined,
        comment,
      });
    }
  } catch (e) {
    ops.logOperationError({
      operationId: req.params.id,
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      route: req.originalUrl,
      action:
        decision === "validate" ? "validate_operation" : "decide_negotiation",
      error: e,
      requestDetails: req.body,
    });
    return res.render("headoffice_decision", {
      op: ops.getOperation(req.params.id),
      audit: ops.getAuditTrail(req.params.id),
      error: e.message,
      form: req.body,
    });
  }
  res.redirect("/siege");
});

module.exports = router;
