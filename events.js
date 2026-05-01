// ivx-events.js — Event Bus
// Provides a global Publish/Subscribe mechanism to decouple modules.
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';

window.IVX = window.IVX || {};
window.IVX.bus = {
  _listeners: {},
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
  },
  emit(event, payload) {
    if (this._listeners[event]) {
      for (const cb of this._listeners[event]) {
        try {
          cb(payload);
        } catch (err) {
          console.error(`IVX.bus error in '${event}' listener:`, err);
        }
      }
    }
  }
};
