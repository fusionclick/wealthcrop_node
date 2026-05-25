const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const rootRoute = require("./route/root-route/rootRoute");

//environment file
dotenv.config();

const app = express();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// CORS Configuration
app.use(cors({
  origin: ["http://localhost:5173"],                  // Sabhi origins allow hain (production mein specific domain set karein)
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  credentials: false            // Agar cookies/auth use karni ho to true karein aur origin mein specific URL dein
}));

// Preflight requests handle karne ke liye
app.options("*", cors());

// Middleware to parse JSON
app.use(express.json());

// Routes
app.use("/", rootRoute);
// app.use("/api/nse", require("./route/all-routes/NseRoutes"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));

