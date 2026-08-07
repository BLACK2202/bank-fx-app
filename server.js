require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

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

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  }),
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
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
