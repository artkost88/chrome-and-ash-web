/* ХРОМ И ПЕПЕЛ — тонкий клиент REST API (фаза 1).
   Контракт: chrome-and-ash-web/docs/06-web-api.md (и server/api-schemas.json).
   Авторизация — только через HttpOnly-cookie (credentials: 'include'), токен в JSON не попадает. */
(function (root) {
  'use strict';

  const BASE = '/api';

  function query(params) {
    if (!params) return '';
    const usp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null) return;
      usp.set(k, String(v));
    });
    const s = usp.toString();
    return s ? '?' + s : '';
  }

  async function request(method, path, body) {
    const opts = {
      method,
      credentials: 'include',
      headers: {},
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(BASE + path, opts);
    } catch (e) {
      const err = new Error('Нет соединения с сервером');
      err.code = 'network';
      err.status = 0;
      err.details = {};
      throw err;
    }

    if (res.status === 204) return null;

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

    if (!res.ok) {
      const envelope = (data && data.error) || {};
      const err = new Error(envelope.message || ('Ошибка сервера (' + res.status + ')'));
      err.code = envelope.code || ('http_' + res.status);
      err.status = res.status;
      err.details = envelope.details || {};
      throw err;
    }

    return data;
  }

  root.API = {
    /* auth */
    register: (payload) => request('POST', '/auth/register', payload),
    login: (payload) => request('POST', '/auth/login', payload),
    logout: () => request('POST', '/auth/logout'),

    /* профиль + активная партия */
    me: () => request('GET', '/me'),

    /* ежедневный заезд */
    daily: () => request('GET', '/daily'),

    /* заезды */
    runs: (params) => request('GET', '/runs' + query(params)),
    startRun: (payload) => request('POST', '/runs', payload),

    /* сохранения */
    getSave: (id) => request('GET', '/save/' + encodeURIComponent(id)),
    putSave: (id, payload) => request('PUT', '/save/' + encodeURIComponent(id), payload),
    deleteSave: (id) => request('DELETE', '/save/' + encodeURIComponent(id)),

    /* лидерборд */
    leaderboard: (params) => request('GET', '/leaderboard' + query(params)),

    /* лобби PvP (фаза 2, server/docs/07-pvp-protocol.md §5) */
    lobbyCreate: (config) => request('POST', '/lobbies', config ? { config } : {}),
    lobbyGet: (code) => request('GET', '/lobbies/' + encodeURIComponent(code)),
    lobbyJoin: (code) => request('POST', '/lobbies/' + encodeURIComponent(code) + '/join'),
    lobbyLeave: (code) => request('POST', '/lobbies/' + encodeURIComponent(code) + '/leave'),
    lobbyStart: (code) => request('POST', '/lobbies/' + encodeURIComponent(code) + '/start'),
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);
