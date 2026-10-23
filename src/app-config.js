// Connection configuration with src/config.js made optional.
//
// src/config.js is gitignored (it carries the OAuth client IDs), so a fresh
// clone has none, and upstream main.js crashed on `require('./config')` before
// the window ever opened. Local Edition loads it when it exists and otherwise
// runs with every integration "not configured": the AI is LM Studio and needs
// nothing from this file.
//
// Local Edition has no accounts, no billing and no telemetry, so the Supabase
// project is always blanked here, even if a config.js still names one. Google
// Calendar and Outlook stay available to anyone who creates their own OAuth
// clients (docs/credentials-needed.md, sections 2 and 3).
'use strict';

const LOCAL_EDITION = true;

function loadUserConfig() {
  try {
    return require('./config');
  } catch (error) {
    // Only "there is no config.js" is expected. A config.js that exists but
    // throws is a real mistake and should be loud.
    if (error && error.code === 'MODULE_NOT_FOUND' && /['"]\.\/config['"]/.test(String(error.message))) return {};
    throw error;
  }
}

const user = loadUserConfig();

const config = {
  supabase: LOCAL_EDITION ? { url: '', anonKey: '' } : { url: '', anonKey: '', ...(user.supabase || {}) },
  googleCalendar: {
    clientId: '',
    clientSecret: '',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    ...(user.googleCalendar || {}),
  },
  outlook: {
    clientId: '',
    tenant: 'common',
    scopes: ['User.Read', 'Mail.Read', 'offline_access'],
    sendScopes: ['User.Read', 'Mail.Read', 'Mail.Send', 'offline_access'],
    ...(user.outlook || {}),
  },
};

function isSupabaseConfigured(cfg) {
  return Boolean(cfg && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey);
}

function isGoogleCalendarConfigured(cfg) {
  return Boolean(cfg && cfg.googleCalendar && cfg.googleCalendar.clientId && cfg.googleCalendar.clientSecret);
}

function isOutlookConfigured(cfg) {
  return Boolean(cfg && cfg.outlook && cfg.outlook.clientId);
}

module.exports = config;
module.exports.LOCAL_EDITION = LOCAL_EDITION;
module.exports.isSupabaseConfigured = isSupabaseConfigured;
module.exports.isGoogleCalendarConfigured = isGoogleCalendarConfigured;
module.exports.isOutlookConfigured = isOutlookConfigured;
