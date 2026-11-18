
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

let databaseReady;

async function setupDatabase() {
  if (!databaseReady) {
    databaseReady = pool.query(`
      CREATE TABLE IF NOT EXISTS market_rates (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        category VARCHAR(20) NOT NULL,
        city VARCHAR(80) NOT NULL,
        buy_price NUMERIC(18,4),
        sell_price NUMERIC(18,4),
        unit VARCHAR(50) NOT NULL,
        source VARCHAR(180) NOT NULL,
        submitted_by VARCHAR(120),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS market_rates_status_idx
      ON market_rates(status);

      CREATE INDEX IF NOT EXISTS market_rates_city_idx
      ON market_rates(city);

      CREATE INDEX IF NOT EXISTS market_rates_created_idx
      ON market_rates(created_at DESC);
    `).catch(error => {
      databaseReady = null;
      throw error;
    });
  }

  return databaseReady;
}

function send(res, status, data) {
  res.status(status).json(data);
}

function adminAuthorized(req) {
  const key = process.env.ADMIN_KEY;
  return key && req.headers["x-admin-key"] === key;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Admin-Key"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (!process.env.DATABASE_URL) {
      return send(res, 503, {
        ok: false,
        message: "DATABASE_URL is not configured"
      });
    }

    await setupDatabase();

    const route = req.query?.route || "health";

    // API health
    if (route === "health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        app: "NerkhYar Afghanistan",
        database: "connected",
        message: "Market Rates API is running"
      });
    }

    // Public approved rates
    if (route === "rates" && req.method === "GET") {
      const city = req.query.city;
      const category = req.query.category;

      const conditions = ["status = 'approved'"];
      const values = [];

      if (city && city !== "تمام افغانستان") {
        values.push(city);
        conditions.push(`city = $${values.length}`);
      }

      if (category && category !== "all") {
        values.push(category);
        conditions.push(`category = $${values.length}`);
      }

      const result = await pool.query(
        `SELECT id, name, category, city,
          buy_price, sell_price, unit, source,
          created_at, approved_at
         FROM market_rates
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT 200`,
        values
      );

      return send(res, 200, {
        ok: true,
        count: result.rows.length,
        rates: result.rows
      });
    }

    // Submit a new rate (requires admin approval)
    if (route === "rates" && req.method === "POST") {
      const {
        name, category, city,
        buy_price, sell_price,
        unit, source, submitted_by
      } = req.body || {};

      const allowed = ["currency", "gold", "food", "fuel"];

      if (
        !name || !allowed.includes(category) ||
        !city || !unit || !source
      ) {
        return send(res, 400, {
          ok: false,
          message: "Required fields are missing"
        });
      }

      const buy = buy_price === "" || buy_price == null
        ? null : Number(buy_price);

      const sell = sell_price === "" || sell_price == null
        ? null : Number(sell_price);

      if (
        (buy !== null && (!Number.isFinite(buy) || buy < 0)) ||
        (sell !== null && (!Number.isFinite(sell) || sell < 0)) ||
        (buy === null && sell === null)
      ) {
        return send(res, 400, {
          ok: false,
          message: "Invalid price"
        });
      }

      const result = await pool.query(
        `INSERT INTO market_rates
        (name, category, city, buy_price, sell_price,
         unit, source, submitted_by, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
        RETURNING id, name, city, status, created_at`,
        [
          name, category, city, buy, sell,
          unit, source, submitted_by || null
        ]
      );

      return send(res, 201, {
        ok: true,
        message: "Rate submitted for admin approval",
        rate: result.rows[0]
      });
    }

    // Admin: view pending rates
    if (route === "pending" && req.method === "GET") {
      if (!adminAuthorized(req)) {
        return send(res, 401, {
          ok: false,
          message: "Unauthorized"
        });
      }

      const result = await pool.query(
        `SELECT * FROM market_rates
         WHERE status = 'pending'
         ORDER BY created_at DESC
         LIMIT 200`
      );

      return send(res, 200, {
        ok: true,
        rates: result.rows
      });
    }

    // Admin: approve a rate
    if (route === "approve" && req.method === "POST") {
      if (!adminAuthorized(req)) {
        return send(res, 401, {
          ok: false,
          message: "Unauthorized"
        });
      }

      const id = Number(req.query.id);

      if (!Number.isSafeInteger(id) || id < 1) {
        return send(res, 400, {
          ok: false,
          message: "Invalid rate ID"
        });
      }

      const result = await pool.query(
        `UPDATE market_rates
         SET status = 'approved',
             approved_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING id, name, city, status, approved_at`,
        [id]
      );

      if (!result.rowCount) {
        return send(res, 404, {
          ok: false,
          message: "Pending rate not found"
        });
      }

      return send(res, 200, {
        ok: true,
        message: "Rate approved",
        rate: result.rows[0]
      });
    }

    return send(res, 404, {
      ok: false,
      message: "Endpoint not found"
    });

  } catch (error) {
    console.error("NerkhYar API error:", error);

    return send(res, 500, {
      ok: false,
      message: "Server error. Check database configuration."
    });
  }
};
