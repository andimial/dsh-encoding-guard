export class EncodingLedger {
    entries = new Map();
    locks = new Map();
    get size() {
        return this.entries.size;
    }
    has(key) {
        return this.entries.has(key);
    }
    get(key) {
        return this.entries.get(key);
    }
    record(key, entry) {
        this.entries.set(key, entry);
    }
    touch(key) {
        const entry = this.entries.get(key);
        if (entry)
            entry.touchedAt = Date.now();
    }
    delete(key) {
        this.entries.delete(key);
    }
    keysBySession(sessionId) {
        const keys = [];
        for (const [key, entry] of this.entries)
            if (entry.sessionId === sessionId)
                keys.push(key);
        return keys;
    }
    allKeys() {
        return [...this.entries.keys()];
    }
    list() {
        return [...this.entries.values()];
    }
    /** per-path 互斥：fn 与同 key 的其他 withLock 调用严格串行。 */
    async withLock(key, fn) {
        const prev = this.locks.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const chain = prev.then(() => gate);
        this.locks.set(key, chain);
        await prev.catch(() => { });
        try {
            return await fn();
        }
        finally {
            release();
            if (this.locks.get(key) === chain)
                this.locks.delete(key);
        }
    }
}
//# sourceMappingURL=ledger.js.map