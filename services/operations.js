const db = require("../db");
const { getSpotRate } = require("./excelRates");

const NEGOTIATION_THRESHOLD = 10000; // below this amount (EUR/USD equivalent), spot rate is mandatory

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
  const tauxFinal = canNegotiate ? null : spot.taux;
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
    tauxFinal,
    status,
    createdBy,
    decidedAt,
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

  const nextStatus =
    op.status === "negotiation_refused_pending_agency"
      ? "negotiation_refused_accepted"
      : "spot_only";

  db.prepare(
    `
    UPDATE operations SET status = ?, taux_final = taux_spot, decided_at = datetime('now')
    WHERE id = ?
  `,
  ).run(nextStatus, operationId);
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
    UPDATE operations SET status = 'negotiation_approved', decided_at = datetime('now')
    WHERE id = ?
  `,
  ).run(operationId);
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
  } else if (decision === "refuse") {
    db.prepare(
      `
      UPDATE operations
      SET status = 'negotiation_refused_pending_agency', taux_final = NULL, decision_comment = ?, decided_by = ?, decided_at = datetime('now')
      WHERE id = ?
    `,
    ).run(comment || null, deciderId, operationId);
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
    WHERE o.status = 'pending_negotiation'
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

function listAllBetween(startDate, endDate) {
  if (!startDate && !endDate) {
    return listAll();
  }

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

  return db
    .prepare(
      `
    SELECT o.*, a.name as agence_name FROM operations o
    JOIN agencies a ON a.id = o.agence_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
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
  refuseNegotiatedRate,
  cancelAfterRefusal,
  requestNegotiation,
  decideNegotiation,
  getOperation,
  listForAgency,
  listPendingNegotiations,
  listAll,
  listAllBetween,
};
