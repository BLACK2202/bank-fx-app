const db = require("../db");

function recordActivity({
  user,
  method,
  route,
  operationId,
  requestKeys,
  responseStatus,
}) {
  db.prepare(
    `
    INSERT INTO user_activity
      (user_id, username, actor_role, method, route, operation_id, request_keys, response_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    user.id,
    user.username,
    user.role,
    method,
    route,
    operationId || null,
    requestKeys && requestKeys.length ? JSON.stringify(requestKeys) : null,
    responseStatus || null,
  );
}

function listActivity({ startDate, endDate, searchTerm } = {}) {
  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push("date(ua.created_at) >= date(?)");
    params.push(startDate);
  }
  if (endDate) {
    conditions.push("date(ua.created_at) <= date(?)");
    params.push(endDate);
  }
  if (searchTerm) {
    const cleaned = `%${String(searchTerm).trim().toLowerCase()}%`;
    conditions.push(`(
      LOWER(COALESCE(ua.username, '')) LIKE ? OR
      LOWER(COALESCE(ua.actor_role, '')) LIKE ? OR
      LOWER(ua.method) LIKE ? OR
      LOWER(ua.route) LIKE ? OR
      CAST(COALESCE(ua.operation_id, '') AS TEXT) LIKE ?
    )`);
    params.push(cleaned, cleaned, cleaned, cleaned, cleaned);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `
      SELECT ua.*
      FROM user_activity ua
      ${where}
      ORDER BY ua.created_at DESC, ua.id DESC
    `,
    )
    .all(...params);
}

module.exports = { recordActivity, listActivity };
