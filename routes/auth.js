const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const activity = require("../services/activity");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { error: null });
});

router.post("/login", (req, res) => {
  const rawUsername = (req.body.username || "").trim();
  const password = req.body.password || "";

  // Normalize username variations like 'back_office' or 'Back Office' to match 'backoffice'
  const normalizedUsername = rawUsername.toLowerCase().replace(/[\s_-]+/g, "");

  let user = db
    .prepare("SELECT * FROM users WHERE LOWER(username) = ?")
    .get(normalizedUsername);

  if (!user) {
    user = db
      .prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)")
      .get(rawUsername);
  }

  if (
    !user ||
    !user.is_active ||
    !bcrypt.compareSync(password, user.password_hash)
  ) {
    activity.recordActivity({
      user: { id: null, username: rawUsername || "unknown", role: "anonymous" },
      method: req.method,
      route: req.originalUrl,
      requestKeys: ["username", "password"],
      responseStatus: 200,
    });
    return res.render("login", { error: "Identifiants incorrects." });
  }
  if (user.role === "agency") {
    const agency = db
      .prepare("SELECT * FROM agencies WHERE id = ?")
      .get(user.agency_id);
    if (!agency || !agency.is_active) {
      return res.render("login", { error: "Compte agence desactive." });
    }
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    agenceId: user.agency_id,
  };
  activity.recordActivity({
    user: req.session.user,
    method: req.method,
    route: req.originalUrl,
    requestKeys: ["username", "password"],
    responseStatus: 302,
  });
  res.redirect("/");
});

router.post("/logout", (req, res) => {
  if (req.session.user) {
    activity.recordActivity({
      user: req.session.user,
      method: req.method,
      route: req.originalUrl,
      requestKeys: [],
      responseStatus: 302,
    });
  }
  req.session.destroy(() => res.redirect("/login"));
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");

  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(req.session.user.id);

  if (!user || !user.is_active) {
    req.session.destroy(() => res.redirect("/login"));
    return;
  }

  if (user.role === "agency") {
    const agency = db
      .prepare("SELECT * FROM agencies WHERE id = ?")
      .get(user.agency_id);
    if (!agency || !agency.is_active) {
      req.session.destroy(() => res.redirect("/login"));
      return;
    }
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    agenceId: user.agency_id,
  };

  next();
}

function requireRole(role) {
  const roles = Array.isArray(role) ? role : [role];
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render("error", { message: "Acces reserve." });
    }
    next();
  };
}

module.exports = { router, requireAuth, requireRole };
