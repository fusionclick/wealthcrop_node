const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const rootRoute = require("./route/root-route/rootRoute");

dotenv.config();

const app = express();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ponytail: open CORS; tighten origins if you turn credentials on
app.use(cors());
app.options("*", cors());
app.use(express.json());

// Dev request log — shows in this terminal (method, path, status, UI screen)
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    const start = Date.now();
    const screen = req.headers["x-client-screen"] || "—";
    res.on("finish", () => {
      console.log(
        `[Node] ${new Date().toLocaleTimeString()} ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms) | UI: ${screen}`
      );
    });
    next();
  });
}

// ponytail: BSE ko ping nahi karta — health check production API par load nahi daalna chahiye
app.get("/health", (req, res) =>
  res.json({ status: "ok", uptime: Math.round(process.uptime()) })
);
app.get("/", (req, res) => res.redirect("/health"));

// All BSE routes live under /api — matches VITE_NODE_URL=http://host:3000/api
app.use("/api", rootRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`WealthCrop BSE proxy listening on port ${port}`));
