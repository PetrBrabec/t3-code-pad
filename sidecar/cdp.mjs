// Minimal Chrome DevTools Protocol client. No dependencies (Node 22 has a global WebSocket).

export const DEFAULT_PORT = Number(process.env.T3PAD_CDP_PORT || 9222);

export async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/** The T3 renderer: the page target whose URL is the app scheme (not devtools, not preview webviews). */
export async function findAppTarget(port = DEFAULT_PORT) {
  const targets = await listTargets(port);
  return (
    targets.find((t) => t.type === "page" && /^t3code(-dev)?:\/\/app/.test(t.url)) ||
    targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"))
  );
}

export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => reject(new Error(`CDP websocket error: ${e.message || e.type}`));
      ws.onclose = () => {
        this.closed = true;
        for (const { reject: rej } of this.pending.values()) rej(new Error("CDP closed"));
        this.pending.clear();
        this.emit("close", {});
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
        } else if (msg.method) {
          this.emit(msg.method, msg.params);
        }
      };
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP closed"));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  emit(method, params) {
    for (const fn of this.listeners.get(method) || []) fn(params);
  }

  /** Evaluate an expression in the page, returning its JSON value or throwing the page exception. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page exception: ${d.exception?.description || d.text}`);
    }
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export async function connectApp(port = DEFAULT_PORT) {
  const target = await findAppTarget(port);
  if (!target) throw new Error(`no T3 page target on 127.0.0.1:${port}`);
  return new CdpSession(target.webSocketDebuggerUrl).open();
}
