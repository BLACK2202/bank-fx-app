const db = require("../db");
const { getSpotRate } = require("./excelRates");

const NEGOTIATION_THRESHOLD = 10000; // below this amount (EUR/USD equivalent), spot rate is mandatory
const SIEGE_VALIDATION_STATUS = "pending_siege_validation";

function insertAudit({
  operationId,
  actorId,
  actorRole,
  action,
  fromStatus,
  toStatus,
  spotRate,
  requestedTaux,
  finalTaux,
  comment,
}) {
  const linkedOperationId =
    operationId && getOperation(operationId) ? operationId : null;

  db.prepare(
    `
    INSERT INTO operation_audit
      (operation_id, actor_id, actor_role, action, from_status, to_status,
       spot_rate, requested_taux, final_taux, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    operationId,
    actorId || null,
    actorRole || null,
    action,
    fromStatus || null,
    toStatus || null,
    spotRate || null,
    requestedTaux || null,
    finalTaux || null,
    comment || null,
  );
}

function getAuditTrail(operationId) {
  return db
    .prepare(
      `
    SELECT oa.*, u.username as actor_username
    FROM operation_audit oa
    LEFT JOIN users u ON u.id = oa.actor_id
    WHERE oa.operation_id = ?
    ORDER BY oa.created_at ASC
  `,
    )
    .all(operationId);
}

function logOperationError({
  operationId,
  actorId,
  actorRole,
  route,
  action,
  error,
  requestDetails,
}) {
  db.prepare(
    `
    INSERT INTO operation_errors
      (operation_id, actor_id, actor_role, route, action, error_message, request_details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    linkedOperationId,
    actorId || null,
    actorRole || null,
    route || null,
    action || null,
    error instanceof Error ? error.message : String(error || "Erreur inconnue"),
    requestDetails ? JSON.stringify(requestDetails) : null,
  );
}

function getErrorTrail(operationId) {
  return db
    .prepare(
      `
    SELECT oe.*, u.username AS actor_username
    FROM operation_errors oe
    LEFT JOIN users u ON u.id = oe.actor_id
    WHERE oe.operation_id = ?
    ORDER BY oe.created_at ASC, oe.id ASC
  `,
    )
    .all(operationId);
}

async function createOperation({
  agenceId,
  natureSujet,
  nomClient,
  numeroCompte,
  sens,
  currencyFrom,
  currencyTo,
  dateValeur,
  montant,
  createdBy,
}) {
  const spot = await getSpotRate(currencyFrom, sens);
  const canNegotiate = montant >= NEGOTIATION_THRESHOLD;
  const status = canNegotiate ? "spot_pending_choice" : "spot_only";
  const finalTaux = canNegotiate ? null : spot.taux;
  const decidedAt = canNegotiate ? null : new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO operations
      (agence_id, nature_sujet, nom_client, numero_compte, sens, devise, currency_from, currency_to, date_valeur,
       montant, taux_spot, taux_source_date, taux_final, status, created_by, decided_at)
    VALUES (@agenceId, @natureSujet, @nomClient, @numeroCompte, @sens, @devise, @currencyFrom, @currencyTo, @dateValeur,
       @montant, @tauxSpot, @tauxSourceDate, @tauxFinal, @status, @createdBy, @decidedAt)
  `);

  const info = stmt.run({
    agenceId,
    natureSujet,
    nomClient,
    numeroCompte,
    sens,
    devise: currencyFrom,
    currencyFrom,
    currencyTo,
    dateValeur,
    montant,
    tauxSpot: spot.taux,
    tauxSourceDate: spot.dateMajFichier,
    tauxFinal: finalTaux,
    status,
    createdBy,
    decidedAt,
  });

  insertAudit({
    operationId: info.lastInsertRowid,
    actorId: createdBy,
    actorRole: "agency",
    action: "operation_created",
    fromStatus: null,
    toStatus: status,
    spotRate: spot.taux,
    requestedTaux: null,
    finalTaux,
    comment: null,
  });

  return { id: info.lastInsertRowid, spot, canNegotiate };
}

function acceptSpot(operationId, agenceId) {
  const op = getOperation(operationId);
  if (!op || op.agence_id !== agenceId)
    throw new Error("Operation introuvable.");
  if (
    op.status !== "spot_pending_choice" &&
    op.status !== "negotiation_refused_pending_agency"
  ) {
    throw new Error("Cette operation ne peut plus etre modifiee.");
  }

  const nextStatus = SIEGE_VALIDATION_STATUS;

  db.prepare(
    `
    UPDATE operations SET status = ?, taux_final = taux_spot, decided_at = NULL
    WHERE id = ?
  `,
  ).run(nextStatus, operationId);

  insertAudit({
    operationId,
    actorId: agenceId,
    actorRole: "agency",
    action: "spot_accepted",
    fromStatus: op.status,
    toStatus: nextStatus,
    spotRate: op.taux_spot,
    requestedTaux: op.requested_taux,
    finalTaux: op.taux_spot,
    comment: null,
  });

  return getOperation(operationId);
}

function acceptNegotiatedRate(operationId, agenceId) {
  const op = getOperation(operationId);
  if (!op || op.agence_id !== agenceId)
    throw new Error("Operation introuvable.");
  if (op.status !== "negotiation_approved_pending_agency") {
    throw new Error("Cette operation ne peut plus etre modifiee.");
  }

  db.prepare(
    `
    UPDATE operations SET status = ?, decided_at = NULL
    WHERE id = ?
  `,
  ).run(SIEGE_VALIDATION_STATUS, operationId);

  insertAudit({
    operationId,
    actorId: agenceId,
    actorRole: "agency",
    action: "negotiation_accepted_by_agency",
    fromStatus: op.status,
    toStatus: SIEGE_VALIDATION_STATUS,
    spotRate: op.taux_spot,
    requestedTaux: op.requested_taux,
    finalTaux: op.taux_final,
    comment: null,
  });

  return getOperation(operationId);
}

function validateOperation(operationId, deciderId, referenceNumber, comment) {
  const op = getOperation(operationId);
  if (!op) throw new Error("Operation introuvable.");
  if (op.status !== SIEGE_VALIDATION_STATUS) {
    throw new Error("Cette operation n'est pas en attente de verification.");
  }

  const reference = String(referenceNumber || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9/-]{2,49}$/.test(reference)) {
    throw new Error(
      "La reference doit contenir entre 3 et 50 caracteres alphanumeriques.",
    );
  }

  db.prepare(
    `
    UPDATE operations
    SET status = 'validated_by_siege', reference_number = ?, decision_comment = ?,
        decided_by = ?, decided_at = datetime('now')
    WHERE id = ?
  `,
  ).run(reference, comment || null, deciderId, operationId);

  insertAudit({
    operationId,
    actorId: deciderId,
    actorRole: "head_office",
    action: "operation_validated_by_siege",
    fromStatus: op.status,
    toStatus: "validated_by_siege",
    spotRate: op.taux_spot,
    requestedTaux: op.requested_taux,
    finalTaux: op.taux_final,
    comment: `${reference}${comment ? ` - ${comment}` : ""}`,
  });

  return getOperation(operationId);
}

function refuseNegotiatedRate(operationId, agenceId) {
  const op = getOperation(operationId);
  if (!op || op.agence_id !== agenceId)
    throw new Error("Operation introuvable.");
  if (op.status !== "negotiation_approved_pending_agency") {
    throw new Error("Cette operation ne peut plus etre modifiee.");
  }

  db.prepare(
    `
    UPDATE operations SET status = 'negotiation_refused_by_agency', taux_final = NULL, decided_at = datetime('now')
    WHERE id = ?
  `,
  ).run(operationId);

  insertAudit({
    operationId,
    actorId: agenceId,
    actorRole: "agency",
    action: "negotiation_refused_by_agency",
    fromStatus: op.status,
    toStatus: "negotiation_refused_by_agency",
    spotRate: op.taux_spot,
    requestedTaux: op.requested_taux,
    finalTaux: null,
    comment: null,
  });

  return getOperation(operationId);
}

function cancelAfterRefusal(operationId, agenceId) {
  const op = getOperation(operationId);
  if (!op || op.agence_id !== agenceId)
    throw new Error("Operation introuvable.");
  if (
    op.status !== "negotiation_refused_pending_agency" &&
    op.status !== "negotiation_approved_pending_agency"
  ) {
    throw new Error("Cette operation ne peut pas etre annulee.");
  }

  db.prepare(
    `
    UPDATE operations
    SET status = 'negotiation_cancelled_by_agency', taux_final = NULL, decided_at = datetime('now')
    WHERE id = ?
  `,
  ).run(operationId);

  insertAudit({
    operationId,
    actorId: agenceId,
    actorRole: "agency",
    action: "operation_cancelled_by_agency",
    fromStatus: op.status,
    toStatus: "negotiation_cancelled_by_agency",
    spotRate: op.taux_spot,
    requestedTaux: op.requested_taux,
    finalTaux: null,
    comment: null,
  });

  return getOperation(operationId);
}

function requestNegotiation(operationId, agenceId, requestedTaux) {
  const op = getOperation(operationId);
  if (!op || op.agence_id !== agenceId)
    throw new Error("Operation introuvable.");
  if (op.montant < NEGOTIATION_THRESHOLD) {
    throw new Error(
      `Montant inferieur a ${NEGOTIATION_THRESHOLD}, la negociation n'est pas autorisee.`,
    );
  }
  if (
    op.status !== "spot_pending_choice" &&
    op.status !== "negotiation_approved_pending_agency"
  )
    throw new Error("Cette operation ne peut plus etre modifiee.");

  if (
    requestedTaux != null &&
    (Number.isNaN(requestedTaux) || requestedTaux <= 0)
  ) {
    throw new Error("Le taux demande doit etre un nombre positif.");
  }

  if (
    op.status === "negotiation_approved_pending_agency" &&
    requestedTaux == null
  ) {
    throw new Error("Veuillez renseigner un taux de contre-proposition.");
  }

  db.prepare(
    `
    UPDATE operations
    SET status = 'pending_negotiation', requested_taux = ?, taux_final = NULL,
        decision_comment = NULL, decided_by = NULL, decided_at = NULL
    WHERE id = ?
  `,
  ).run(requestedTaux, operationId);

  insertAudit({
    operationId,
    actorId: agenceId,
    actorRole: "agency",
    action:
      op.status === "spot_pending_choice"
        ? "negotiation_requested_by_agency"
        : "negotiation_counterproposal_by_agency",
    fromStatus: op.status,
    toStatus: "pending_negotiation",
    spotRate: op.taux_spot,
    requestedTaux,
    finalTaux: null,
    comment: null,
  });

  return getOperation(operationId);
}

function decideNegotiation(
  operationId,
  deciderId,
  decision,
  { finalTaux, comment } = {},
) {
  const op = getOperation(operationId);
  if (!op) throw new Error("Operation introuvable.");
  if (op.status !== "pending_negotiation")
    throw new Error("Cette operation n'est pas en attente de decision.");

  if (decision === "approve") {
    if (
      finalTaux == null ||
      Number.isNaN(Number(finalTaux)) ||
      Number(finalTaux) <= 0
    ) {
      throw new Error(
        "Le taux final doit etre renseigne pour une acceptation.",
      );
    }
    const taux = Number(finalTaux);
    db.prepare(
      `
      UPDATE operations
      SET status = 'negotiation_approved_pending_agency', taux_final = ?, decision_comment = ?, decided_by = ?, decided_at = datetime('now')
      WHERE id = ?
    `,
    ).run(taux, comment || null, deciderId, operationId);

    insertAudit({
      operationId,
      actorId: deciderId,
      actorRole: "head_office",
      action: "negotiation_approved_by_siege",
      fromStatus: op.status,
      toStatus: "negotiation_approved_pending_agency",
      spotRate: op.taux_spot,
      requestedTaux: op.requested_taux,
      finalTaux: taux,
      comment: comment || null,
    });
  } else if (decision === "refuse") {
    db.prepare(
      `
      UPDATE operations
      SET status = 'negotiation_refused_pending_agency', taux_final = NULL, decision_comment = ?, decided_by = ?, decided_at = datetime('now')
      WHERE id = ?
    `,
    ).run(comment || null, deciderId, operationId);

    insertAudit({
      operationId,
      actorId: deciderId,
      actorRole: "head_office",
      action: "negotiation_refused_by_siege",
      fromStatus: op.status,
      toStatus: "negotiation_refused_pending_agency",
      spotRate: op.taux_spot,
      requestedTaux: op.requested_taux,
      finalTaux: null,
      comment: comment || null,
    });
  } else {
    throw new Error("Decision inconnue.");
  }
  return getOperation(operationId);
}

function getOperation(id) {
  return db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
}

function listForAgency(agenceId) {
  return db
    .prepare(
      "SELECT * FROM operations WHERE agence_id = ? ORDER BY created_at DESC",
    )
    .all(agenceId);
}

function listPendingNegotiations() {
  return db
    .prepare(
      `
    SELECT o.*, a.name as agence_name FROM operations o
    JOIN agencies a ON a.id = o.agence_id
    WHERE o.status IN ('pending_negotiation', 'pending_siege_validation')
    ORDER BY o.created_at ASC
  `,
    )
    .all();
}

function listAll() {
  return db
    .prepare(
      `
    SELECT o.*, a.name as agence_name FROM operations o
    JOIN agencies a ON a.id = o.agence_id
    ORDER BY o.created_at DESC
  `,
    )
    .all();
}

function listAllBetween(startDate, endDate, searchTerm) {
  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push("date(o.created_at) >= date(?)");
    params.push(startDate);
  }
  if (endDate) {
    conditions.push("date(o.created_at) <= date(?)");
    params.push(endDate);
  }

  if (searchTerm) {
    const cleaned = `%${searchTerm.trim().toLowerCase()}%`;
    conditions.push(
      `(
        CAST(o.id AS TEXT) LIKE ? OR
        LOWER(a.name) LIKE ? OR
        LOWER(o.nom_client) LIKE ? OR
        LOWER(o.status) LIKE ? OR
        LOWER(o.currency_from) LIKE ? OR
        LOWER(o.currency_to) LIKE ? OR
        LOWER(COALESCE(o.reference_number, '')) LIKE ?
      )`,
    );
    params.push(cleaned, cleaned, cleaned, cleaned, cleaned, cleaned, cleaned);
  }

  if (!conditions.length) {
    return listAll();
  }

  return db
    .prepare(
      `
    SELECT o.*, a.name as agence_name FROM operations o
    JOIN agencies a ON a.id = o.agence_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY o.created_at DESC
  `,
    )
    .all(...params);
}

module.exports = {
  NEGOTIATION_THRESHOLD,
  createOperation,
  acceptSpot,
  acceptNegotiatedRate,
  validateOperation,
  refuseNegotiatedRate,
  cancelAfterRefusal,
  requestNegotiation,
  decideNegotiation,
  getOperation,
  getAuditTrail,
  logOperationError,
  getErrorTrail,
  listForAgency,
  listPendingNegotiations,
  listAll,
  listAllBetween,
};
