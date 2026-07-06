const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const rootRoute = require("./route/root-route/rootRoute");

dotenv.config();

const app = express();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://wealthcrop.co",
  "https://www.wealthcrop.co",
  "https://wealthcrop.netlify.app",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: false,
  })
);

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

// All BSE routes live under /api — matches VITE_NODE_URL=http://host:3000/api
app.use("/api", rootRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`WealthCrop BSE proxy listening on port ${port}`));
