// atamgo-auth.js — headers for calls from the browser to the n8n webhooks.
//
// The webhooks used to trust one shared token typed into this (public) repo, which anyone could copy.
// They now verify the signed-in user's own Supabase login token (the Authorization header) instead.
//
// TRANSITION: LEGACY_TOKEN is still sent so the site keeps working while the n8n webhooks are switched over.
// Once every webhook only accepts the login token, delete LEGACY_TOKEN and the line that sends it.
(function () {
  'use strict';

  const LEGACY_TOKEN = '42f5d7bb154d98a8cfc5d8b7e2d83693a088e0f78b2357bf352c518ce25f07cc';
  let client = null;

  function sb() {
    if (window._atamSb) return window._atamSb;
    if (!client) {
      const cfg = window.ATAM_GO_CONFIG || {};
      client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
    return client;
  }

  async function accessToken() {
    try {
      const { data } = await sb().auth.getSession();
      return data && data.session ? data.session.access_token : '';
    } catch (e) {
      return '';
    }
  }

  window.atamGoWebhookHeaders = async function () {
    const headers = { 'Content-Type': 'application/json', 'X-Atam-Go-Token': LEGACY_TOKEN };
    const token = await accessToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  };
})();
