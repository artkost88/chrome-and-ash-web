/* ХРОМ И ПЕПЕЛ — WebSocket-слой фазы 2 (PvP).
   Контракт: server/docs/07-pvp-protocol.md §2–§4.
   Соединение / reconnect с экспоненциальным backoff / keepalive (ping→pong).
   Авторизация — через cookie (handshake GET /ws), токен в сообщения не попадает. */
(function (root) {
  'use strict';

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function wsUrl() {
    if (typeof location !== 'undefined') {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }
    return '/ws';
  }

  class PvpSocket {
    constructor(opts) {
      opts = opts || {};
      this.url = opts.url || wsUrl();
      this.onMessage = opts.onMessage || function () {};
      this.onOpen = opts.onOpen || function () {};
      this.onClose = opts.onClose || function () {};
      this.onError = opts.onError || function () {};
      this.ws = null;
      this._closedByUser = false;
      this._reconnectDelay = 500;
      this._reconnectTimer = null;
      this._pingTimer = null;
    }

    get isOpen() { return !!(this.ws && this.ws.readyState === 1); }

    connect() {
      this._closedByUser = false;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleReconnect();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this._reconnectDelay = 500;
        this._startPing();
        this.onOpen();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && typeof msg.type === 'string') this.onMessage(msg);
      };
      ws.onclose = () => {
        this._stopPing();
        this.ws = null;
        this.onClose();
        this._scheduleReconnect();
      };
      ws.onerror = () => { this.onError(); };
    }

    _scheduleReconnect() {
      if (this._closedByUser || this._reconnectTimer) return;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect();
      }, this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 8000);
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this.isOpen) this.send({ type: 'ping', t: Date.now() });
      }, 25000);
    }

    _stopPing() {
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    send(obj) {
      if (this.isOpen) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    close() {
      this._closedByUser = true;
      this._stopPing();
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    }
  }

  root.CnA_WS = { PvpSocket, uuid };

})(typeof globalThis !== 'undefined' ? globalThis : window);
