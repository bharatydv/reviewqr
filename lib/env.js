import fs from 'node:fs';
import path from 'node:path';

// Minimal .env reader. Supports KEY=value, # comments, blank lines, "quoted"
// and 'quoted' values, and \n escapes inside double quotes. Values already in
// process.env win, so real environment variables always override the file.
export function loadEnv(file = path.join(process.cwd(), '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const parsed = {};
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replace(/\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    parsed[key] = value;
    if (!(key in process.env)) process.env[key] = value;
  }
  return parsed;
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

export function buildConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';
  const config = {
    nodeEnv,
    isProduction,
    isTest,
    port: int(env.PORT, 3000, 0, 65535),
    baseUrl: (env.BASE_URL || `http://localhost:${int(env.PORT, 3000, 0, 65535)}`).replace(/\/+$/, ''),
    adminToken: env.ADMIN_TOKEN || '',
    dbPath: env.DB_PATH || './data/reviewqr.db',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    // Clamped to the documented 3-6 range.
    maxVisibleReviews: int(env.MAX_VISIBLE_REVIEWS, 6, 3, 6),
    // The Blue Door Cafe demo exists so a fresh local install has something to
    // scan. A real deployment starts empty and gets its businesses from the
    // admin console, so this is off in production unless asked for. Setting it
    // either way wins over the default.
    seedDemo: env.SEED_DEMO ? env.SEED_DEMO === '1' : nodeEnv !== 'production',
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587, 1, 65535),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || 'ReviewQR <no-reply@example.com>',
    },
    // Google One Tap. Empty means the prompt never appears and customers
    // review with the device cookie as identity, exactly as before.
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      timeoutMs: 15000,
    },
  };
  config.smtpConfigured = Boolean(config.smtp.host);
  return config;
}

// Fatal misconfiguration should stop the process before it serves traffic.
export function assertConfig(config) {
  const problems = [];
  if (!config.adminToken) {
    problems.push('ADMIN_TOKEN is required.');
  } else if (config.isProduction && config.adminToken.length < 16) {
    problems.push('ADMIN_TOKEN must be at least 16 characters in production.');
  }
  if (config.isProduction) {
    // SMTP is not required: customers review without being asked for anything.
    // It is only needed by a business that turns on email verification, and
    // that is reported when a code is actually requested.
    if (config.smtpConfigured && !config.smtp.from) {
      problems.push('MAIL_FROM is required when SMTP is configured.');
    }
    if (config.adminToken === 'change-me-please') problems.push('ADMIN_TOKEN still has its example value.');
    if (!/^https:\/\//.test(config.baseUrl)) problems.push('BASE_URL should be an https:// URL in production.');
  }
  return problems;
}
