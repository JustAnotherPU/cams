'use strict';

/*
 * The app's status for MainApp, as the Store app reports it: ACTIVE while the app is on screen,
 * holds a home-screen widget or runs work that must go on hidden (hold), INACTIVE otherwise.
 *
 * MainApp keeps the two most recent inactive apps and stops the others 10 s after they go
 * (AppsInactivityHandler, foregroundAppsInactivitySettings). An app that stays ACTIVE ranks at its
 * backgroundPriority (200) and is never stopped: every app once opened stayed in the 1000 MiB the
 * apps share, until MEMORY_LOW made MainApp refuse every start and kill one app every 8 s.
 *
 * Until it is first shown the app stays ACTIVE: the SDK sends the status MainApp holds at initialized(),
 * and an app INACTIVE then, never shown, is stopped at once (backgroundAppInactive, no 10 s delay). The
 * HMI publishes stacks without the app (empty, or before its screen opens) during the start, so a hide
 * counts only once the app was on screen (the Store does the same, store.js _sawForeground).
 */
class Life {
    constructor(app, log) {
        this.app = app;
        this.log = log;
        this.shown = null;      // null: not shown yet
        this.widget = false;
        this.jobs = new Set();
        this.sent = null;       // the status last sent
    }

    want() { return this.shown !== false || this.widget || this.jobs.size > 0; }

    /** Send the status if it changed (force: send it anyway, e.g. once the status channel is up). */
    sync(force) {
        const on = this.want();
        if (!force && on === this.sent) return Promise.resolve();
        this.sent = on;
        const why = on ? (this.shown !== false ? 'on screen' : this.widget ? 'widget' : 'running ' + [...this.jobs].join(', ')) : 'hidden';
        return Promise.resolve()
            .then(() => (on ? this.app.registerActive() : this.app.registerInactive()))
            .then(() => this.log.info('registered ' + (on ? 'active' : 'inactive') + ' (' + why + ')'))
            .catch((e) => { this.sent = null; this.log.warn('app status: ' + e); });   // sent again next time
    }

    setShown(on) {
        if (!on && this.shown === null) return Promise.resolve();   // not on screen yet: not a hide
        this.shown = !!on;
        return this.sync();
    }
    setWidget(on) { this.widget = !!on; return this.sync(); }
    /** hold(name, true) while work that must go on hidden runs; hold(name, false) when it ends. */
    hold(name, on) {
        if (on) this.jobs.add(name); else this.jobs.delete(name);
        return this.sync();
    }
}

module.exports = { Life };
