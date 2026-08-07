const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireRole } = require("./auth");

const router = express.Router();

router.use(requireRole("admin"));

function loadDashboardData() {
  const agencies = db
    .prepare(
      `
    SELECT a.*, COUNT(u.id) AS user_count
    FROM agencies a
    LEFT JOIN users u ON u.agency_id = a.id
    GROUP BY a.id
    ORDER BY a.id ASC
  `,
    )
    .all();

  const users = db
    .prepare(
      `
    SELECT u.*, a.name AS agency_name
    FROM users u
    LEFT JOIN agencies a ON a.id = u.agency_id
    ORDER BY u.id DESC
  `,
    )
    .all();

  return { agencies, users };
}

router.get("/", (req, res) => {
  const { agencies, users } = loadDashboardData();
  res.render("admin_dashboard", { agencies, users, error: null, form: {} });
});

router.post("/agencies", (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) {
    const { agencies, users } = loadDashboardData();
    return res.render("admin_dashboard", {
      agencies,
      users,
      error: "Merci de remplir tous les champs agence.",
      form: req.body,
    });
  }

  try {
    db.prepare(
      "INSERT INTO agencies (id, name, is_active) VALUES (?, ?, 1)",
    ).run(id.trim(), name.trim());
  } catch (e) {
    const { agencies, users } = loadDashboardData();
    return res.render("admin_dashboard", {
      agencies,
      users,
      error: e.message,
      form: req.body,
    });
  }

  res.redirect("/admin");
});

router.post("/agencies/:id/toggle", (req, res) => {
  const agency = db
    .prepare("SELECT * FROM agencies WHERE id = ?")
    .get(req.params.id);
  if (!agency)
    return res.status(404).render("error", { message: "Agence introuvable." });

  const nextActive = agency.is_active ? 0 : 1;
  db.prepare("UPDATE agencies SET is_active = ? WHERE id = ?").run(
    nextActive,
    agency.id,
  );
  if (!nextActive) {
    db.prepare("UPDATE users SET is_active = 0 WHERE agency_id = ?").run(
      agency.id,
    );
  }
  res.redirect("/admin");
});

router.post("/users", (req, res) => {
  const { username, full_name, password, role, agency_id } = req.body;
  const trimmedUsername = (username || "").trim();
  const trimmedName = (full_name || "").trim();
  if (!trimmedUsername || !trimmedName || !password || !role) {
    const { agencies, users } = loadDashboardData();
    return res.render("admin_dashboard", {
      agencies,
      users,
      error: "Merci de remplir tous les champs utilisateur.",
      form: req.body,
    });
  }
  if (role === "agency" && !agency_id) {
    const { agencies, users } = loadDashboardData();
    return res.render("admin_dashboard", {
      agencies,
      users,
      error: "Veuillez choisir une agence pour ce compte.",
      form: req.body,
    });
  }

  try {
    db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(
      trimmedUsername,
      bcrypt.hashSync(password, 10),
      trimmedName,
      role,
      role === "agency" ? agency_id : null,
    );
  } catch (e) {
    const { agencies, users } = loadDashboardData();
    return res.render("admin_dashboard", {
      agencies,
      users,
      error: e.message,
      form: req.body,
    });
  }

  res.redirect("/admin");
});

router.post("/users/:id/toggle", (req, res) => {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(req.params.id);
  if (!user)
    return res
      .status(404)
      .render("error", { message: "Utilisateur introuvable." });

  const nextActive = user.is_active ? 0 : 1;
  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(
    nextActive,
    user.id,
  );
  res.redirect("/admin");
});

module.exports = router;
