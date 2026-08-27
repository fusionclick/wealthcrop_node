require("./config");

const http = require("http");
const express = require("express");
const cors = require("cors");
const dns = require("dns");
const rootRoute = require("./route/root-route/rootRoute");
const StarMFController = require("./controllers/StarMFController");
const { attachNavSocket } = require("./mf/navSocket");

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const app = express();

// ponytail: lock CORS to known frontends
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://wealthcrop.co.in",
  "https://www.wealthcrop.co.in",
  "https://wealthcrop.co",
  "https://www.wealthcrop.co",
  "https://khelobindass.com",
  "https://www.khelobindass.com",
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
app.options("*", cors({ origin: allowedOrigins }));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

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
const server = http.createServer(app);
attachNavSocket(server, StarMFController);
server.listen(port, () => {
  console.log(`WealthCrop BSE proxy listening on port ${port}`);
});
