require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const activity = require("./services/activity");

const { router: authRouter, requireAuth } = require("./routes/auth");
const agencyRouter = require("./routes/agency");
const headOfficeRouter = require("./routes/headoffice");
const adminRouter = require("./routes/admin");
const officeRouter = require("./routes/office");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const SESSION_MAX_AGE_MINUTES = Number(
  process.env.SESSION_MAX_AGE_MINUTES || 60,
);
const SESSION_INACTIVITY_TIMEOUT_MINUTES = Number(
  process.env.SESSION_INACTIVITY_TIMEOUT_MINUTES || 15,
);

app.use(
  session({
    name: "bankfx.sid",
    secret: process.env.SESSION_SECRET || "change-me-in-production",
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: { maxAge: SESSION_MAX_AGE_MINUTES * 60 * 1000 },
  }),
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;

  if (req.session.user) {
    const now = Date.now();
    const lastActivity = req.session.lastActivity || now;
    if (now - lastActivity > SESSION_INACTIVITY_TIMEOUT_MINUTES * 60 * 1000) {
      req.session.destroy(() => {
        return res.redirect("/login");
      });
      return;
    }
    req.session.lastActivity = now;
  }

  if (req.session.user) {
    res.on("finish", () => {
      const operationMatch = req.path.match(/\/operation(?:s)?\/(\d+)/i);
      try {
        activity.recordActivity({
          user: req.session.user,
          method: req.method,
          route: req.originalUrl.split("?")[0],
          operationId: operationMatch ? Number(operationMatch[1]) : null,
          requestKeys: Object.keys(req.body || {}),
          responseStatus: res.statusCode,
        });
      } catch (error) {
        console.error("Unable to record user activity:", error.message);
      }
    });
  }

  next();
});

app.use("/", authRouter);
app.use("/admin", requireAuth, adminRouter);
app.use("/office", requireAuth, officeRouter);
app.use("/agence", requireAuth, agencyRouter);
app.use("/siege", requireAuth, headOfficeRouter);

app.get("/", requireAuth, (req, res) => {
  if (req.session.user.role === "admin") return res.redirect("/admin");
  if (
    req.session.user.role === "middle_office" ||
    req.session.user.role === "back_office"
  )
    return res.redirect("/office");
  if (req.session.user.role === "head_office") return res.redirect("/siege");
  res.redirect("/agence");
});

app.use((req, res) => {
  res.status(404).render("error", { message: "Page introuvable." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bank FX app running on http://localhost:${PORT}`);
});
