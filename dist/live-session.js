// One request at a time; both displays derive their clock from the match server.
export class LiveSession {
  constructor({request, onState, onError, evidence}) {
    Object.assign(this, {request, onState, onError, evidence});
    this.room = null;
    this.chain = Promise.resolve();
    this.timer = null;
    this.receivedAt = 0;
    this.serverAtReceipt = 0;
    this.generation = 0;
    this.finishRequested = false;
  }
  serverNow() { return this.serverAtReceipt + performance.now() - this.receivedAt; }
  terminal(room = this.room) { return !room || ['complete', 'cancelled', 'void'].includes(room.phase); }
  accept(room, rtt = 0) {
    this.room = room;
    this.receivedAt = performance.now();
    this.serverAtReceipt = room.serverTime + rtt / 2;
    this.onState(room);
  }
  open(room) {
    this.stop();
    this.finishRequested = false;
    this.accept(room);
    this.schedule(0);
  }
  stop() { clearTimeout(this.timer); this.timer = null; this.generation++; }
  // At most one rep-triggered sync is queued during a slow request. A later
  // heartbeat sends any remaining cumulative evidence after a network failure.
  pushEvidence() {
    if(this.repSyncPending||this.terminal())return this.repSyncPending||Promise.resolve();
    this.repSyncPending=this.sync().catch(()=>{}).finally(()=>{this.repSyncPending=null;});
    return this.repSyncPending;
  }
  schedule(delay = 1000) {
    clearTimeout(this.timer);
    if (this.terminal()) return;
    this.timer = setTimeout(() => this.sync().catch(() => {}), delay);
  }
  sync(extra = {}) {
    clearTimeout(this.timer);
    if (extra.finished === true) this.finishRequested = true;
    const generation = this.generation;
    const id = this.room?.id;
    if (!id) return Promise.reject(new Error('Open a duel first.'));
    const task = async () => {
      if (generation !== this.generation) return;
      // Countdown heartbeats must not contain rep evidence: the round is not open yet.
      const acceptsEvidence = ['running', 'finishing'].includes(this.room?.phase);
      const events = acceptsEvidence ? this.evidence() : undefined;
      const payload = {id, ...(events ? {events} : {}), ...(this.finishRequested ? {finished:true} : {}), ...extra};
      const started = performance.now();
      try {
        const result = await this.request('live/sync', payload);
        if (generation === this.generation) this.accept(result.room, performance.now() - started);
        return result.room;
      } catch (error) {
        if (generation === this.generation) this.onError(error);
        throw error;
      } finally {
        if (generation === this.generation) this.schedule();
      }
    };
    const operation = this.chain.then(task, task);
    this.chain = operation.catch(() => {});
    return operation;
  }
}
