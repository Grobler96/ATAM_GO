// atamgo-auth.js — headers for calls from the browser to the n8n webhooks.
//
// The n8n webhooks used to trust one shared token typed into this (public) repo, which anyone could copy.
// They now verify the signed-in user's own Supabase login token (the Authorization header) with Supabase,
// so there is no shared secret in the browser. A request without a valid login is answered with 401.
(function () {
  'use strict';

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

  // Shared HTML escaper for tabs that build markup from database text.
  window.atamEsc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  window.atamGoWebhookHeaders = async function () {
    const headers = { 'Content-Type': 'application/json' };
    const token = await accessToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  };
})();
